//services/pacotesService.js

import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { registrarCancelamentoLog } from './cancelamentosLogService.js';
import notificacoesDispatch from './notificacoesDispatch.js';
import reembolsosGatewayFilaService from './reembolsosGatewayFilaService.js';
import { HttpError } from '../utils/httpError.js';
import { log } from '../config/logger.js';
import { agoraBrasilDate } from '../utils/appDateTime.js';

// ---------------- helpers ----------------
function assertId(v, name = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} inválido.`);
  return n;
}

function requireUser(usuario) {
  if (!usuario?.tipo || usuario?.id == null) throw new HttpError(401, 'Não autenticado.');
}

function isPaciente(usuario) {
  return String(usuario?.tipo || '').toLowerCase() === 'paciente';
}

function isAdmin(usuario) {
  return String(usuario?.tipo || '').toLowerCase() === 'admin';
}

function normalizeText(v, max = 200) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function toCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
function fromCents(c) {
  return Number((c / 100).toFixed(2));
}

function parseBooleanish(v) {
  if (v === true || v === 1) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return ['true', '1', 'sim', 's', 'yes', 'y'].includes(s);
}

/**
 * Normaliza status do gateway para um "bucket" simples
 * - 'Pago'      => pacote pode virar crédito (gera créditos)
 * - 'Pendente'  => aguardando confirmação (webhook/consulta)
 * - 'Cancelado' => não gera créditos
 */
function normalizeGatewayStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return { normalized: 'Pendente', raw: null };

  // pago/aprovado
  if (
    ['pago', 'aprovado', 'approved', 'paid', 'succeeded', 'success', 'captured'].includes(s)
  ) {
    return { normalized: 'Pago', raw: status };
  }

  // cancelado/recusado
  if (
    ['cancelado', 'canceled', 'cancelled', 'failed', 'refused', 'denied', 'expired', 'chargeback'].includes(s)
  ) {
    return { normalized: 'Cancelado', raw: status };
  }

  return { normalized: 'Pendente', raw: status };
}

async function carregarPrecoBaseFisio(fisioterapeutaId, usuario, especialidadeId = null) {
  const espId = especialidadeId == null || especialidadeId === ''
    ? null
    : assertId(especialidadeId, 'EspecialidadeId');

  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      req.input('EspecialidadeId', sql.Int, espId);
    },
    espId
      ? `
        SELECT TOP (1)
          f.Id AS FisioterapeutaId,
          f.TipoConta,
          f.DescontoPacote,
          fe.EspecialidadeId,
          e.Nome AS EspecialidadeNome,
          vcf.ValorPacienteFinal AS ValorConsulta
        FROM dbo.Fisioterapeutas f
        JOIN dbo.FisioterapeutaEspecialidades fe
          ON fe.FisioterapeutaId = f.Id
        JOIN dbo.Especialidades e
          ON e.Id = fe.EspecialidadeId
        CROSS APPLY dbo.fn_ValorConsultaFinal(fe.ValorConsultaBase) vcf
        WHERE f.Id = @FisioterapeutaId
          AND fe.EspecialidadeId = @EspecialidadeId
          AND fe.ValorConsultaBase IS NOT NULL;
      `
      : `
        SELECT TOP (1)
          v.FisioterapeutaId,
          v.TipoConta,
          v.ValorConsulta,
          v.DescontoPacote,
          esp.EspecialidadeId,
          esp.EspecialidadeNome
        FROM dbo.vw_FisioterapeutaPerfilPublico v
        OUTER APPLY (
          SELECT TOP (1)
            fe.EspecialidadeId,
            e.Nome AS EspecialidadeNome
          FROM dbo.FisioterapeutaEspecialidades fe
          JOIN dbo.Especialidades e ON e.Id = fe.EspecialidadeId
          WHERE fe.FisioterapeutaId = v.FisioterapeutaId
            AND fe.Principal = 1
          ORDER BY fe.Id ASC
        ) esp
        WHERE v.FisioterapeutaId = @FisioterapeutaId;
      `
  );

  const row = result?.recordset?.[0];
  if (!row?.FisioterapeutaId) {
    if (espId) {
      throw new HttpError(400, 'Especialidade não disponível ou sem preço configurado para este fisioterapeuta.');
    }
    throw new HttpError(404, 'Fisioterapeuta não encontrado.');
  }

  const valorConsulta = Number(row.ValorConsulta ?? 0);
  const descontoPacote = Number(row.DescontoPacote ?? 0);
  const tipoConta = row.TipoConta ?? null;

  return {
    valorConsulta,
    descontoPacote,
    tipoConta,
    especialidadeId: row.EspecialidadeId ?? espId,
    especialidadeNome: row.EspecialidadeNome ?? null,
  };
}

// Sumário do contrato/políticas (não bloqueia se não existir)
async function carregarSumarioContrato(usuario) {
  try {
    const usuarioTipo = String(usuario?.tipoUsuario ?? usuario?.tipo ?? usuario?.UsuarioTipo ?? 'Paciente');
    const usuarioId = Number(usuario?.id ?? usuario?.usuarioId ?? usuario?.UsuarioId ?? null);

    const rDoc = await queryWithContext(usuario, (req) => {
        req.input('UsuarioTipo', sql.NVarChar(40), usuarioTipo);
        req.input('UsuarioId', sql.Int, Number.isFinite(usuarioId) ? usuarioId : null);

        req.input('Tipo', sql.NVarChar(80), 'CancelamentoReembolso');
      },
      `
        IF OBJECT_ID('dbo.vw_DocumentosLegais_Ativos', 'V') IS NOT NULL
        BEGIN
          SELECT TOP (1)
            d.Id,
            d.Tipo,
            d.Versao,
            d.Titulo,
            d.Conteudo,
            d.PublicadoEm,
            d.AtualizadoEm
          FROM dbo.vw_DocumentosLegais_Ativos d WITH (NOLOCK)
          WHERE d.Tipo = @Tipo;
        END
      `
    );

    return rDoc?.recordset?.[0] ?? null;
  } catch (err) {
    log('error', 'Erro ao carregar sumário de contrato (CancelamentoReembolso)', {
      erro: err?.message || err
    });
    return null;
  }
}

async function validarAceiteCompraPacote(dados, usuario) {
  const documentoLegalId = assertId(
    dados?.DocumentoLegalId ?? dados?.documentoLegalId,
    'DocumentoLegalId'
  );
  const aceitou = parseBooleanish(dados?.AceitouSumarioContrato ?? dados?.aceitouSumarioContrato);
  if (!aceitou) {
    throw new HttpError(400, 'Você precisa aceitar o sumário do contrato antes de continuar.');
  }

  const result = await queryWithContext(usuario, (req) => {
    req.input('DocumentoLegalId', sql.Int, documentoLegalId);
    req.input('Ip', sql.NVarChar(60), normalizeText(dados?.IpAceite ?? dados?.ipAceite, 60));
    req.input('UserAgent', sql.NVarChar(400), normalizeText(dados?.UserAgentAceite ?? dados?.userAgentAceite, 400));
    req.input('Origem', sql.NVarChar(40), normalizeText(dados?.OrigemAceite ?? dados?.origemAceite ?? 'CompraPacote', 40));
  }, `
    DECLARE @DocumentoLegalIdAtual INT = NULL;

    IF OBJECT_ID('dbo.vw_DocumentosLegais_Ativos', 'V') IS NOT NULL
    BEGIN
      SELECT TOP (1)
        @DocumentoLegalIdAtual = d.Id
      FROM dbo.vw_DocumentosLegais_Ativos d
      WHERE d.Tipo = N'CancelamentoReembolso'
      ORDER BY COALESCE(d.AtualizadoEm, d.PublicadoEm) DESC, d.Id DESC;
    END

    IF @DocumentoLegalIdAtual IS NULL
      THROW 51220, N'O sumário do contrato não está disponível no momento.', 1;

    IF @DocumentoLegalIdAtual <> @DocumentoLegalId
      THROW 51221, N'O sumário do contrato foi atualizado. Revise e confirme novamente antes de continuar.', 1;

    EXEC dbo.sp_RegistrarAceiteDocumentoLegal
      @DocumentoLegalId = @DocumentoLegalIdAtual,
      @Ip = @Ip,
      @UserAgent = @UserAgent,
      @Origem = @Origem;
  `);

  return result?.recordset ?? null;
}

async function pacoteTemCreditos(pacoteId, usuario) {
  const r = await queryWithContext(
    usuario,
    (req) => req.input('PacoteId', sql.Int, pacoteId),
    `
      SELECT TOP (1) 1 AS Tem
      FROM dbo.CreditosPacientes
      WHERE PacoteId = @PacoteId;
    `
  );
  return (r?.recordset?.[0]?.Tem ?? 0) === 1;
}

async function gerarCreditosPacote(pacoteId, pacienteId, usuario) {
  // idempotência: se já tem créditos, não tenta gerar novamente
  const tem = await pacoteTemCreditos(pacoteId, usuario);
  if (tem) return { jaExistia: true };

  await queryWithContext(
    usuario,
    (req) => {
      req.input('PacoteId', sql.Int, pacoteId);
      req.input('PacienteId', sql.Int, pacienteId);
    },
    `
      EXEC dbo.SP_Pacote_GerarCreditos
        @PacoteId = @PacoteId,
        @PacienteId = @PacienteId;
    `
  );

  return { jaExistia: false };
}

async function marcarPacoteAtivo(pacoteId, usuario, extras = {}) {
  const { gatewayStatusRaw = null, gateway = null, gatewayPaymentId = null, valorPago = null } = extras;

  await queryWithContext(
    usuario,
    (req) => {
      req.input('PacoteId', sql.Int, pacoteId);
      req.input('Status', sql.NVarChar(60), 'Ativo');
      req.input('Gateway', sql.NVarChar(50), gateway);
      req.input('GatewayPaymentId', sql.NVarChar(120), gatewayPaymentId);
      req.input('GatewayStatus', sql.NVarChar(120), gatewayStatusRaw);
      req.input('ValorPago', sql.Decimal(10, 2), valorPago);
      req.input('AgoraBrasil', sql.DateTime2(7), agoraBrasilDate());
    },
    `
      UPDATE dbo.Pacotes
      SET
        Status = @Status,
        Gateway = COALESCE(@Gateway, Gateway),
        GatewayPaymentId = COALESCE(@GatewayPaymentId, GatewayPaymentId),
        GatewayStatus = COALESCE(@GatewayStatus, GatewayStatus),
        ValorPago = COALESCE(@ValorPago, ValorPago),
        PagoEm = COALESCE(PagoEm, @AgoraBrasil)
      WHERE Id = @PacoteId;
    `
  );
}

async function registrarSnapshotPacotePago(pacoteId, usuario) {
  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('PacoteId', sql.Int, pacoteId);
      req.input('CriadoPor', sql.NVarChar(100), usuario?.nome || usuario?.email || 'pacotesService.confirmarPagamento');
    },
    `
      EXEC dbo.SP_Financeiro_RegistrarPacotePago
        @PacoteId = @PacoteId,
        @CriadoPor = @CriadoPor,
        @Silencioso = 0;
    `
  );

  return result?.recordset?.[0] ?? null;
}

async function marcarPacoteCancelado(pacoteId, usuario, extras = {}) {
  const { gatewayStatusRaw = null, gateway = null, gatewayPaymentId = null } = extras;

  await queryWithContext(
    usuario,
    (req) => {
      req.input('PacoteId', sql.Int, pacoteId);
      req.input('Status', sql.NVarChar(60), 'Cancelado');
      req.input('Gateway', sql.NVarChar(50), gateway);
      req.input('GatewayPaymentId', sql.NVarChar(120), gatewayPaymentId);
      req.input('GatewayStatus', sql.NVarChar(120), gatewayStatusRaw);
      req.input('AgoraBrasil', sql.DateTime2(7), agoraBrasilDate());
    },
    `
      UPDATE dbo.Pacotes
      SET
        Status = @Status,
        Gateway = COALESCE(@Gateway, Gateway),
        GatewayPaymentId = COALESCE(@GatewayPaymentId, GatewayPaymentId),
        GatewayStatus = COALESCE(@GatewayStatus, GatewayStatus),
        CanceladoEm = COALESCE(CanceladoEm, @AgoraBrasil)
      WHERE Id = @PacoteId;
    `
  );
}

async function buscarPacotePorId(pacoteId, usuario) {
  const id = assertId(pacoteId, 'pacoteId');

  const r = await queryWithContext(usuario, (req) => {
    req.input('PacoteId', sql.Int, id);
  }, `
    SELECT TOP (1)
      p.Id,
      p.PacienteId,
      p.FisioterapeutaId,

      pa.Nome AS PacienteNome,
      f.Nome  AS NomeFisioterapeuta,
      p.EspecialidadeId,
      e.Nome AS EspecialidadeNome,

      -- valor avulso histórico da época da compra do pacote
      COALESCE(p.ValorUnitarioAvulso, vpp.ValorConsulta) AS ValorSessaoAvulsa,

      p.NomePacote AS Nome,
      p.NomePacote,
      p.QuantidadeConsultas,
      p.ConsultasUtilizadas,
      p.ValorTotal,
      p.ValorUnitarioAvulso,
      p.DataCompra,
      p.Validade,
      p.Status,
      p.Gateway,
      p.GatewayPaymentId,
      p.GatewayInstallmentId,
      p.GatewayStatus,
      p.GatewayRefundStatus,
      p.GatewayRefundValor,
      p.GatewayRefundDescricao,
      p.GatewayRefundSolicitadoEm,
      p.GatewayRefundConfirmadoEm,
      p.GatewayUltimoEvento,
      p.ValorPago,
      p.CriadoEm,
      p.PagoEm,
      p.CanceladoEm
    FROM dbo.Pacotes p
    LEFT JOIN dbo.Pacientes pa
      ON pa.Id = p.PacienteId
    LEFT JOIN dbo.Fisioterapeutas f
      ON f.Id = p.FisioterapeutaId
    LEFT JOIN dbo.Especialidades e
      ON e.Id = p.EspecialidadeId
    LEFT JOIN dbo.vw_FisioterapeutaPerfilPublico vpp
      ON vpp.FisioterapeutaId = p.FisioterapeutaId
    WHERE p.Id = @PacoteId
      AND (
        COALESCE(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'') = N'Admin'
        OR (
          CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)) = N'Paciente'
          AND p.PacienteId = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'))
        )
        OR (
          CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)) = N'Fisioterapeuta'
          AND p.FisioterapeutaId = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'))
        )
      );
  `);

  return r?.recordset?.[0] ?? null;
}



function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function diffDays(dateA, dateB) {
  // SQL datetime2 chega ao JS como wall-clock em UTC fake; compare os dias usando UTC parts.
  if (!(dateA instanceof Date) || isNaN(dateA.getTime())) return null;
  if (!(dateB instanceof Date) || isNaN(dateB.getTime())) return null;
  const a = Date.UTC(dateA.getUTCFullYear(), dateA.getUTCMonth(), dateA.getUTCDate());
  const b = Date.UTC(dateB.getUTCFullYear(), dateB.getUTCMonth(), dateB.getUTCDate());
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

function normalizeOpcaoReembolso(v) {
  const s = normalizeText(v ?? '', 30);
  if (!s) return null;
  const up = s.toUpperCase();
  if (up === 'CREDITO' || up === 'CRÉDITO' || up === 'CREDITO_CARTEIRA' || up === 'CREDITO CARTEIRA') return 'Credito';
  if (up === 'REEMBOLSO' || up === 'ESTORNO') return 'Reembolso';
  return null;
}

async function garantirReembolsoPacoteEnfileirado(pacote, usuario) {
  const pacoteId = Number(pacote?.Id);
  if (!Number.isInteger(pacoteId) || pacoteId <= 0) {
    throw new HttpError(400, 'Pacote inválido para enfileirar reembolso.');
  }

  const statusPacote = String(pacote?.Status || '').trim();
  const gatewayStatus = String(pacote?.GatewayStatus || '').trim().toUpperCase();
  const gatewayRefundStatus = String(pacote?.GatewayRefundStatus || '').trim().toUpperCase();
  const solicitacaoRegistrada =
    statusPacote.toUpperCase() === 'CANCELADO' &&
    (
      ['REEMBOLSOPENDENTE', 'REEMBOLSOFALHOU'].includes(gatewayStatus) ||
      gatewayRefundStatus.length > 0
    );

  if (!solicitacaoRegistrada) {
    throw new HttpError(409, 'Não existe solicitação de reembolso registrada para este pacote.');
  }

  if (['DONE', 'PARTIAL'].includes(gatewayRefundStatus)) {
    return {
      confirmado: true,
      enfileirado: false,
      fila: null,
      pacoteId,
    };
  }

  if (['DENIED', 'REFUSED', 'CANCELLED', 'CANCELED'].includes(gatewayRefundStatus)) {
    throw new HttpError(
      409,
      `O reembolso do pacote está com status ${gatewayRefundStatus} e requer análise administrativa.`
    );
  }

  const valor = round2(pacote?.GatewayRefundValor);
  if (valor <= 0) {
    throw new HttpError(
      409,
      'O valor calculado do reembolso não foi preservado. Encaminhe o pacote para análise administrativa.'
    );
  }

  const fila = await reembolsosGatewayFilaService.enfileirarReembolso({
    pacoteId,
    origem: 'Pacote',
    provider: 'asaas',
    gatewayPaymentId: pacote?.GatewayPaymentId ?? null,
    gatewayInstallmentId: pacote?.GatewayInstallmentId ?? null,
    valor,
    motivo:
      pacote?.GatewayRefundDescricao ||
      `Cancelamento do pacote #${pacoteId}`,
  }, usuario);

  return {
    confirmado: false,
    enfileirado: true,
    fila,
    pacoteId,
  };
}

async function buscarSumarioContratoCancelamento(usuario) {
  try {
    const rDoc = await queryWithContext(usuario, null, `
      SELECT TOP (1)
        dl.Id     AS DocumentoLegalId,
        dl.Tipo   AS Tipo,
        dl.Titulo AS Titulo,
        dl.Versao AS Versao,
        dl.Conteudo AS Conteudo,
        dl.PublicadoEm AS PublicadoEm,
        dl.AtualizadoEm AS AtualizadoEm
      FROM dbo.vw_DocumentosLegais_Ativos dl
      WHERE dl.Tipo = N'CancelamentoReembolso';
    `);
    return rDoc?.recordset?.[0] ?? null;
  } catch (err) {
    // Mantém fallback sem quebrar fluxo, mas registra o erro real para diagnóstico.
    log('warn', '[buscarSumarioContratoCancelamento] Erro ignorado', {
      erro: err?.message || err
    });
    return null;
  }
}

async function buscarConsultasEmAndamentoPacote(pacoteId, usuario) {
  const id = assertId(pacoteId, 'pacoteId');

  const rows = await queryWithContext(usuario, (req) => {
    req.input('PacoteId', sql.Int, id);
  }, `
    ;WITH X AS (
      SELECT
        c.Id,
        c.DataHora,
        c.Status,
        c.StatusPagamento
      FROM dbo.CreditosPacientes cp WITH (NOLOCK)
      INNER JOIN dbo.Consultas c WITH (NOLOCK)
        ON c.Id = cp.ConsultaId
      WHERE cp.PacoteId = @PacoteId
        AND LTRIM(RTRIM(ISNULL(cp.Status, N''))) = N'Usado'
        AND cp.ConsultaId IS NOT NULL
        AND (
          LTRIM(RTRIM(ISNULL(c.Status, N''))) IN (N'Aguardando', N'Confirmada')
        )
    )
    SELECT
      t.Total AS ConsultasEmAndamento,
      p1.Id AS ConsultaId,
      p1.DataHora,
      p1.Status,
      p1.StatusPagamento
    FROM (SELECT COUNT(1) AS Total FROM X) t
    OUTER APPLY (SELECT TOP (1) * FROM X ORDER BY DataHora) p1;
  `);

  const row = rows?.recordset?.[0] ?? null;
  const total = Number(row?.ConsultasEmAndamento ?? 0) || 0;

  return {
    total,
    primeira: row?.ConsultaId ? {
      Id: Number(row.ConsultaId),
      DataHora: row.DataHora,
      Status: row.Status,
      StatusPagamento: row.StatusPagamento,
    } : null,
  };
}

async function calcularCancelamentoPacote(pacote, usuario) {
  const now = agoraBrasilDate();

  const qtd = Number(pacote?.QuantidadeConsultas ?? 0) || 0;
  const utilizadas = Number(pacote?.ConsultasUtilizadas ?? 0) || 0;

  const valorPagoCents = toCents(pacote?.ValorPago ?? pacote?.ValorTotal ?? 0);
  const valorSessaoAvulsaCents = toCents(pacote?.ValorSessaoAvulsa ?? 0);
  const valorSessaoPacoteCents = qtd > 0 ? Math.round(valorPagoCents / qtd) : 0;

  // Data da compra: preferimos PagoEm (se existir), senão DataCompra, senão CriadoEm
  const rawDataCompra = pacote?.PagoEm ?? pacote?.DataCompra ?? pacote?.CriadoEm ?? null;
  const dataCompraDate = rawDataCompra ? new Date(rawDataCompra) : null;
  const diasDesdeCompra =
    dataCompraDate instanceof Date && !isNaN(dataCompraDate.getTime())
      ? diffDays(dataCompraDate, now)
      : null;

  const { total: consultasEmAndamento, primeira: primeiraConsultaEmAndamento } =
    await buscarConsultasEmAndamentoPacote(pacote?.Id, usuario);

  const sessoesPrestadas = Math.max(0, utilizadas);
  const sessoesDisponiveis = Math.max(0, qtd - sessoesPrestadas);
  const pacoteTotalmenteConsumido = qtd > 0 && sessoesPrestadas >= qtd;
  const valorSessoesPrestadasCents = Math.max(0, sessoesPrestadas * valorSessaoAvulsaCents);
  const valorPagoSessoesNoPacoteCents = Math.max(0, sessoesPrestadas * valorSessaoPacoteCents);

  // Defaults (principalmente pro caso “consumido”)
  let saldoNominalCents = 0;
  let diferencaCobrarCents = 0;
  let multaCents = 0;
  let valorDevolverCents = 0;

  const emPrazoReflexao = diasDesdeCompra !== null && diasDesdeCompra <= 7;

  // Só existe reembolso integral se NÃO usou nada e NÃO tem consulta em andamento
  const elegivelReembolsoIntegral = emPrazoReflexao && sessoesPrestadas === 0 && consultasEmAndamento === 0;

  // Se ainda não consumiu 100%, mantém sua lógica atual
  if (!pacoteTotalmenteConsumido) {
    saldoNominalCents = Math.max(0, valorPagoCents - valorPagoSessoesNoPacoteCents);
    diferencaCobrarCents = Math.max(0, valorSessoesPrestadasCents - valorPagoSessoesNoPacoteCents);

    const saldoAjustadoCents = Math.max(0, saldoNominalCents - diferencaCobrarCents);
    multaCents = elegivelReembolsoIntegral ? 0 : Math.round((saldoAjustadoCents * 10) / 100);
    valorDevolverCents = Math.max(0, saldoAjustadoCents - multaCents);
  } else {
    // Pacote 100% usado => sem devolução e sem cobrança (cancelamento “não aplicável”)
    saldoNominalCents = 0;
    diferencaCobrarCents = 0;
    multaCents = 0;
    valorDevolverCents = 0;
  }

  const valorPago = fromCents(valorPagoCents);
  const valorSessaoAvulsa = fromCents(valorSessaoAvulsaCents);
  const valorSessaoPacote = fromCents(valorSessaoPacoteCents);
  const valorSessoesPrestadas = fromCents(valorSessoesPrestadasCents);
  const valorPagoSessoesNoPacote = fromCents(valorPagoSessoesNoPacoteCents);
  const saldoNominal = fromCents(saldoNominalCents);
  const diferencaCobrar = fromCents(diferencaCobrarCents);
  const multa = fromCents(multaCents);
  const valorDevolver = fromCents(valorDevolverCents);

  return {
    pacoteId: Number(pacote?.Id),
    pacienteId: Number(pacote?.PacienteId),
    pacienteNome: pacote?.PacienteNome ?? null,
    fisioterapeutaId: Number(pacote?.FisioterapeutaId),
    fisioterapeutaNome: pacote?.NomeFisioterapeuta ?? null,
    valorSessaoAvulsa,
    valorPago,
    valorSessoesPrestadas,
    saldoNominal,
    multa,
    valorDevolver,
    diferencaCobrar,
    sessoesPrestadas,
    sessoesDisponiveis,
    consultasEmAndamento,
    primeiraConsultaEmAndamento,
    emPrazoReflexao,
    elegivelReembolsoIntegral,
    diasDesdeCompra,
    pacoteTotalmenteConsumido,
    cancelamentoNaoAplicavel: pacoteTotalmenteConsumido,
  };
}


// ---------------- service ----------------
const pacotesService = {
  async resumoPreCompra(dados, usuario) {
    requireUser(usuario);

    if (!isPaciente(usuario) && !isAdmin(usuario)) {
      throw new HttpError(403, 'Somente Paciente (ou Admin) pode consultar a prévia do pacote.');
    }

    const fisioterapeutaId = assertId(dados?.FisioterapeutaId ?? dados?.fisioterapeutaId, 'FisioterapeutaId');
    const especialidadeIdInput = dados?.EspecialidadeId ?? dados?.especialidadeId ?? null;
    const quantidade = assertId(dados?.QuantidadeConsultas ?? dados?.quantidadeConsultas, 'QuantidadeConsultas');

    if (quantidade < 2) throw new HttpError(400, 'O pacote deve ter no mínimo 2 consultas.');
    if (quantidade > 100) throw new HttpError(400, 'QuantidadeConsultas muito alta (limite: 100).');

    const {
      valorConsulta,
      descontoPacote,
      especialidadeId,
      especialidadeNome
    } = await carregarPrecoBaseFisio(fisioterapeutaId, usuario, especialidadeIdInput);

    const descontoAplicado = Math.min(Math.max(Number(descontoPacote || 0), 0), 100);
    const valorUnitarioCents = Math.max(
      0,
      toCents(valorConsulta) - Math.round(toCents(valorConsulta) * (descontoAplicado / 100))
    );
    const valorUnitario = fromCents(valorUnitarioCents);
    const valorTotal = fromCents(valorUnitarioCents * quantidade);
    const valorTotalAvulso = fromCents(toCents(valorConsulta) * quantidade);
    const economia = fromCents(Math.max(0, toCents(valorTotalAvulso) - toCents(valorTotal)));

    if (valorTotal <= 0) throw new HttpError(400, 'ValorTotal do pacote inválido (<= 0).');

    const resumoResult = await queryWithContext(usuario, (req) => {
      req.input('ValorTotal', sql.Decimal(18, 2), valorTotal);
      req.input('AgoraBrasil', sql.DateTime2(7), agoraBrasilDate());
    }, `
      SELECT TOP (1)
        CAST(ISNULL(decv.ValorBase, 0) AS DECIMAL(10,2)) AS ValorPacote,
        CAST(ISNULL(decv.ValorServicoPlataforma, 0) AS DECIMAL(10,2)) AS TaxaServico,
        CAST(
          CASE
            WHEN @ValorTotal
                 - ISNULL(decv.ValorBase, 0)
                 - ISNULL(decv.ValorServicoPlataforma, 0) < 0
              THEN 0
            ELSE @ValorTotal
                 - ISNULL(decv.ValorBase, 0)
                 - ISNULL(decv.ValorServicoPlataforma, 0)
          END AS DECIMAL(10,2)
        ) AS TaxaTransacao,
        CAST(@ValorTotal AS DECIMAL(10,2)) AS Total
      FROM dbo.fn_DecomporValorPacienteV3(
        @ValorTotal,
        N'Pacote',
        1,
        CAST(@AgoraBrasil AS DATE),
        0,
        0,
        NULL,
        NULL
      ) decv;
    `);

    const resumo = resumoResult?.recordset?.[0] ?? {};

    return {
      resumoFinanceiro: {
        ValorPacote: Number(resumo.ValorPacote ?? 0) || 0,
        TaxaServico: Number(resumo.TaxaServico ?? 0) || 0,
        TaxaTransacao: Number(resumo.TaxaTransacao ?? 0) || 0,
        Total: Number(resumo.Total ?? valorTotal) || valorTotal,
      },
      precificacao: {
        valorConsultaBase: valorConsulta,
        descontoPacotePercentual: descontoAplicado,
        valorUnitario,
        valorTotal,
        valorTotalAvulso,
        economia,
        quantidadeConsultas: quantidade,
        especialidadeId: especialidadeId ?? null,
        especialidadeNome: especialidadeNome ?? null,
      },
    };
  },

  /**
   * POST /api/pacotes/comprar
   * - calcula o preço com base na especialidade selecionada, ou na principal quando EspecialidadeId não vier
   * - registra o aceite do sumário do contrato
   * - cria o pacote como PendentePagamento; o checkout Asaas e o webhook ativam os créditos
   *
   * Body esperado:
   * {
   *   FisioterapeutaId: number,
   *   QuantidadeConsultas: number,
   *   Nome?: string,
   *   DocumentoLegalId: number,
   *   AceitouSumarioContrato: boolean
   * }
   */
  async comprar(dados, usuario) {
    requireUser(usuario);

    const pacienteId = isAdmin(usuario)
      ? assertId(dados?.PacienteId ?? dados?.pacienteId, 'PacienteId')
      : assertId(usuario.id, 'PacienteId');

    const fisioterapeutaId = assertId(dados?.FisioterapeutaId ?? dados?.fisioterapeutaId, 'FisioterapeutaId');
    const especialidadeIdInput = dados?.EspecialidadeId ?? dados?.especialidadeId ?? null;

    const quantidade = assertId(dados?.QuantidadeConsultas ?? dados?.quantidadeConsultas, 'QuantidadeConsultas');
    if (quantidade < 2) throw new HttpError(400, 'O pacote deve ter no mínimo 2 consultas.');
    if (quantidade > 100) throw new HttpError(400, 'QuantidadeConsultas muito alta (limite: 100).');

    const nome = normalizeText(dados?.Nome ?? dados?.nome ?? `Pacote ${quantidade} consultas`, 120);
    const enviouValidadeDias =
      Object.prototype.hasOwnProperty.call(dados ?? {}, 'ValidadeDias') ||
      Object.prototype.hasOwnProperty.call(dados ?? {}, 'validadeDias');
    if (enviouValidadeDias) {
      throw new HttpError(400, 'ValidadeDias não é suportado neste endpoint.');
    }

    // 1) preço base da especialidade selecionada
    const {
      valorConsulta,
      descontoPacote,
      especialidadeId,
      especialidadeNome
    } = await carregarPrecoBaseFisio(fisioterapeutaId, usuario, especialidadeIdInput);

    // 2) desconto percentual configurado pelo fisio, igual ao valor exibido no app.
    const descontoAplicado = Math.min(Math.max(Number(descontoPacote || 0), 0), 100);

    const valorUnitarioCents = Math.max(0, toCents(valorConsulta) - Math.round(toCents(valorConsulta) * (descontoAplicado / 100)));
    const valorUnitario = fromCents(valorUnitarioCents);
    const valorTotal = fromCents(valorUnitarioCents * quantidade);

    if (valorTotal <= 0) throw new HttpError(400, 'ValorTotal do pacote inválido (<= 0).');

    await validarAceiteCompraPacote(dados, usuario);
    const sumarioContrato = await carregarSumarioContrato(usuario);

    // 4) cria pacote no banco
    const insert = await queryWithContext(
      usuario,
      (req) => {
        req.input('PacienteId', sql.Int, pacienteId);
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
        req.input('Nome', sql.NVarChar(120), nome);
        req.input('QuantidadeConsultas', sql.Int, quantidade);
        req.input('ValorTotal', sql.Decimal(10, 2), valorTotal);
        req.input('ValorUnitarioAvulso', sql.Decimal(10, 2), valorConsulta);
        req.input('EspecialidadeId', sql.Int, especialidadeId ?? null);

        req.input('Status', sql.NVarChar(60), 'PendentePagamento');

        req.input('Gateway', sql.NVarChar(50), 'asaas');
        req.input('GatewayPaymentId', sql.NVarChar(120), null);
        req.input('GatewayStatus', sql.NVarChar(120), 'Pendente');
        req.input('ValorPago', sql.Decimal(10, 2), null);
        req.input('AgoraBrasil', sql.DateTime2(7), agoraBrasilDate());

      },
      `
        INSERT INTO dbo.Pacotes
          (PacienteId, FisioterapeutaId, EspecialidadeId, NomePacote, QuantidadeConsultas, ConsultasUtilizadas, ValorTotal, ValorUnitarioAvulso, Validade, Status,
           Gateway, GatewayPaymentId, GatewayStatus, ValorPago, CriadoEm, PagoEm, CanceladoEm)
        VALUES
          (@PacienteId, @FisioterapeutaId, @EspecialidadeId, @Nome, @QuantidadeConsultas, 0, @ValorTotal, @ValorUnitarioAvulso, NULL, @Status,
           @Gateway, @GatewayPaymentId, @GatewayStatus, @ValorPago, @AgoraBrasil, NULL, NULL);

        SELECT SCOPE_IDENTITY() AS PacoteId;
      `
    );

    const pacoteId = Number(insert?.recordset?.[0]?.PacoteId);
    if (!pacoteId) throw new HttpError(500, 'Falha ao criar pacote.');

    // 5) compra NÃO ativa nem gera créditos (isso acontece só no confirmarPagamento)
    let geracao = null;

    // Carrega do banco o pacote recém-criado para devolver ao controller
      const pacote = await buscarPacotePorId(pacoteId, usuario);
      if (!pacote) throw new HttpError(500, 'Falha ao carregar pacote criado.');

      return {
        pacote,
        precificacao: {
          valorConsultaBase: valorConsulta,
          descontoPacotePercentual: descontoAplicado,
          valorUnitario,
          valorTotal,
          especialidadeId: especialidadeId ?? null,
          especialidadeNome: especialidadeNome ?? null,
        },
        pagamento: null,
        geracaoCreditos: geracao ?? null,
        sumarioContrato: sumarioContrato ?? null,
      };

  },

  /**
   * POST /api/pacotes/:id/confirmar-pagamento
   *
   * Para produção:
   * - endpoint pensado para ser chamado por webhook/rotina do gateway (ou Admin no Postman)
   * - quando confirmado como "Pago", gera créditos e ativa o pacote
   */
  async confirmarPagamento(pacoteId, dados, usuario) {
    requireUser(usuario);

    const id = assertId(pacoteId, 'pacoteId');
    const pacote = await buscarPacotePorId(id, usuario);
    if (!pacote) throw new HttpError(404, 'Pacote não encontrado.');

    // Paciente só pode confirmar o próprio pacote (útil p/ testes)
    if (!isAdmin(usuario)) {
      if (!isPaciente(usuario) || Number(usuario.id) !== Number(pacote.PacienteId)) {
        throw new HttpError(403, 'Acesso negado.');
      }
    }

    const gateway = normalizeText(dados?.Gateway ?? dados?.gateway ?? pacote.Gateway ?? null, 50);
    const gatewayPaymentId = normalizeText(dados?.GatewayPaymentId ?? dados?.gatewayPaymentId ?? pacote.GatewayPaymentId ?? null, 120);
    const statusEntrada = dados?.GatewayStatus ?? dados?.gatewayStatus ?? dados?.Status ?? dados?.status ?? null;
    const valorPago = dados?.ValorPago ?? dados?.valorPago ?? pacote.ValorPago ?? null;

    const { normalized: bucket, raw } = normalizeGatewayStatus(statusEntrada ?? pacote.GatewayStatus ?? null);
    const statusAtual = String(normalizeText(pacote?.Status ?? '', 60) || '').toUpperCase();

    if (statusAtual === 'CANCELADO' && bucket === 'Pago') {
      throw new HttpError(409, 'Pacote já cancelado. Não é permitido reativar via confirmação de pagamento.');
    }

    let geracao = null;
    let snapshotFinanceiro = null;

    if (bucket === 'Cancelado') {
      await marcarPacoteCancelado(id, usuario, { gatewayStatusRaw: raw, gateway, gatewayPaymentId });
    } else if (bucket === 'Pago') {
      if (statusAtual === 'ATIVO') {
        // Idempotência: pacote já ativo, evita reprocessar créditos/ativação.
        await queryWithContext(
          usuario,
          (req) => {
            req.input('PacoteId', sql.Int, id);
            req.input('Gateway', sql.NVarChar(50), gateway);
            req.input('GatewayPaymentId', sql.NVarChar(120), gatewayPaymentId);
            req.input('GatewayStatus', sql.NVarChar(120), raw ?? null);
            req.input('ValorPago', sql.Decimal(10, 2), valorPago);
          },
          `
            UPDATE dbo.Pacotes
            SET
              Gateway = COALESCE(@Gateway, Gateway),
              GatewayPaymentId = COALESCE(@GatewayPaymentId, GatewayPaymentId),
              GatewayStatus = COALESCE(@GatewayStatus, GatewayStatus),
              ValorPago = COALESCE(@ValorPago, ValorPago)
            WHERE Id = @PacoteId
              AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'Ativo';
          `
        );
        snapshotFinanceiro = await registrarSnapshotPacotePago(id, usuario);
      } else {
      // gera créditos (idempotente) e ativa
        geracao = await gerarCreditosPacote(id, Number(pacote.PacienteId), usuario);
        await marcarPacoteAtivo(id, usuario, { gatewayStatusRaw: raw, gateway, gatewayPaymentId, valorPago });
        snapshotFinanceiro = await registrarSnapshotPacotePago(id, usuario);
      }
    } else {
      // pendente: só atualiza metadados, mantém status atual se já estiver Ativo/Cancelado
      await queryWithContext(
        usuario,
        (req) => {
          req.input('PacoteId', sql.Int, id);
          req.input('Gateway', sql.NVarChar(50), gateway);
          req.input('GatewayPaymentId', sql.NVarChar(120), gatewayPaymentId);
          req.input('GatewayStatus', sql.NVarChar(120), raw ?? null);
        },
        `
          UPDATE dbo.Pacotes
          SET
            Gateway = COALESCE(@Gateway, Gateway),
            GatewayPaymentId = COALESCE(@GatewayPaymentId, GatewayPaymentId),
            GatewayStatus = COALESCE(@GatewayStatus, GatewayStatus),
            Status = CASE
              WHEN Status IN (N'Ativo', N'Cancelado') THEN Status
              ELSE N'PendentePagamento'
            END
          WHERE Id = @PacoteId;
        `
      );
    }

    const atualizado = await buscarPacotePorId(id, usuario);

    return {
      pacote: atualizado,
      geracaoCreditos: geracao,
      gatewayStatusBucket: bucket,
      snapshotFinanceiro,
    };
  },
  

  /**
   * GET /api/pacotes/:id/opcoes-cancelamento
   *
   * Retorna:
   * - pacote (com nomes)
   * - sumário do contrato de cancelamento/reembolso (se existir)
   * - simulação de cancelamento (valores, multa, etc.)
   * - opções possíveis e bloqueios
   */
  async opcoesCancelamento(pacoteId, usuario) {
    requireUser(usuario);

    const id = assertId(pacoteId, 'pacoteId');
    const pacote = await buscarPacotePorId(id, usuario);
    if (!pacote) throw new HttpError(404, 'Pacote não encontrado.');

    // Paciente só pode ver o próprio pacote (útil p/ testes)
    if (!isAdmin(usuario)) {
      if (!isPaciente(usuario) || Number(usuario.id) !== Number(pacote.PacienteId)) {
        throw new HttpError(403, 'Acesso negado.');
      }
    }

    const cancelamento = await calcularCancelamentoPacote(pacote, usuario);

    const bloqueios = [];

    const statusAtual = normalizeText(pacote?.Status ?? '', 50);
    if (statusAtual && statusAtual.toUpperCase() === 'CANCELADO') {
      bloqueios.push({
        codigo: 'PACOTE_JA_CANCELADO',
        mensagem: 'Este pacote já está cancelado.',
      });
    }

    if ((cancelamento?.consultasEmAndamento ?? 0) > 0) {
      bloqueios.push({
        codigo: 'CONSULTAS_EM_ANDAMENTO',
        mensagem: 'Existem consultas em andamento pagas com este pacote. Cancele/reagende essas consultas antes de cancelar o pacote.',
      });
    }

    if (cancelamento?.pacoteTotalmenteConsumido) {
      bloqueios.push({
        codigo: 'PACOTE_TOTALMENTE_CONSUMIDO',
        mensagem: 'Este pacote já foi utilizado integralmente e não pode ser cancelado.',
      });
    }

    const permitido = bloqueios.length === 0;

    const opcoes = [
      {
        tipo: 'Reembolso',
        permitido,
        titulo: 'Reembolso',
        descricao: cancelamento?.elegivelReembolsoIntegral
          ? 'Reembolso integral (prazo de 7 dias e sem uso do pacote).'
          : 'Reembolso conforme regras (pode haver cobrança de diferença e multa).',
      },
      {
        tipo: 'Credito',
        permitido,
        titulo: 'Crédito em carteira',
        descricao: cancelamento?.elegivelReembolsoIntegral
          ? 'Crédito integral em carteira (prazo de 7 dias e sem uso do pacote).'
          : 'Crédito em carteira conforme regras (pode haver cobrança de diferença e multa).',
      },
    ];

    const sumarioContrato = permitido ? await carregarSumarioContrato(usuario) : null;

    return { pacote, sumarioContrato, cancelamento, opcoes, bloqueios };
  },

  /**
   * POST /api/pacotes/:id/cancelar
   *
   * Body:
   * - opcaoReembolso: "Credito" | "Reembolso"
   * - motivo (opcional)
   */
  async cancelar(pacoteId, dados, usuario) {
    requireUser(usuario);

    const id = assertId(pacoteId, 'pacoteId');
    const pacote = await buscarPacotePorId(id, usuario);
    if (!pacote) throw new HttpError(404, 'Pacote não encontrado.');

    if (!isAdmin(usuario)) {
      if (!isPaciente(usuario) || Number(usuario.id) !== Number(pacote.PacienteId)) {
        throw new HttpError(403, 'Acesso negado.');
      }
    }

    const opcaoReembolso = normalizeOpcaoReembolso(
      dados?.opcaoReembolso ?? dados?.OpcaoReembolso ?? dados?.tipo ?? dados?.Tipo ?? null
    );
    if (!opcaoReembolso) {
      throw new HttpError(400, 'opcaoReembolso inválida. Use "Credito" ou "Reembolso".');
    }

    const motivoUsuario = normalizeText(dados?.motivo ?? dados?.Motivo ?? null, 400);
    const observacaoUsuario = normalizeText(
      dados?.observacao ?? dados?.Observacao ?? null,
      1000
    );

    const statusAtual = normalizeText(pacote?.Status ?? '', 50);
    if (statusAtual && statusAtual.toUpperCase() === 'CANCELADO') {
      if (opcaoReembolso === 'Reembolso') {
        const recuperacao = await garantirReembolsoPacoteEnfileirado(pacote, usuario);
        const atualizado = await buscarPacotePorId(id, usuario);

        return {
          pacote: atualizado,
          sumarioContrato: null,
          cancelamento: null,
          opcaoReembolso,
          reembolsoGateway: recuperacao.fila,
          reembolsoConfirmado: recuperacao.confirmado,
          idempotente: true,
        };
      }

      throw new HttpError(409, 'Este pacote já está cancelado.');
    }

    // Calcula cancelamento + bloqueios
    const cancelamento = await calcularCancelamentoPacote(pacote, usuario);

    if ((cancelamento?.consultasEmAndamento ?? 0) > 0) {
      throw new HttpError(
        409,
        'Existem consultas em andamento pagas com este pacote. Cancele/reagende essas consultas antes de cancelar o pacote.'
      );
    }

    // bloqueia se pacote já foi totalmente consumido
    if (cancelamento?.pacoteTotalmenteConsumido || (cancelamento?.sessoesDisponiveis ?? 0) <= 0) {
      throw new HttpError(
        409,
        'Pacote já foi totalmente utilizado (0 sessões disponíveis). Não é possível cancelar/reembolsar.'
      );
    }

    const valorDevolver = round2(cancelamento?.valorDevolver ?? 0);

    // Persistimos primeiro e processamos gateway depois para evitar estorno sem baixa no banco.
    let reembolsoGateway = null;

    const motivoCancelamentoBase = `Cancelamento do pacote #${id}`;
    const motivoCancelamento = motivoUsuario
      ? `${motivoCancelamentoBase} - ${motivoUsuario}`
      : motivoCancelamentoBase;

    const gatewayStatusCancelamento = opcaoReembolso === 'Credito'
      ? 'CreditoCarteira'
      : 'ReembolsoPendente';

    // Persistência
    await queryWithContext(usuario, (req) => {
      req.input('PacoteId', sql.Int, id);
      req.input('PacienteId', sql.Int, Number(pacote?.PacienteId));
      req.input('MotivoCancelamento', sql.NVarChar(600), motivoCancelamento);
      req.input('GatewayStatusCancelamento', sql.NVarChar(120), gatewayStatusCancelamento);
      req.input('ValorCreditoCarteira', sql.Decimal(10, 2), valorDevolver);
      req.input('SolicitarReembolso', sql.Bit, opcaoReembolso === 'Reembolso' ? 1 : 0);
      req.input('GatewayRefundValor', sql.Decimal(10, 2), valorDevolver);
      req.input('GatewayRefundDescricao', sql.NVarChar(500), motivoCancelamento);

      // texto para o crédito em carteira (se aplicável)
      const motivoCredito = opcaoReembolso === 'Credito'
        ? `Cancelamento do pacote #${id} (crédito em carteira livre).`
        : null;
      req.input('MotivoCreditoCarteira', sql.NVarChar(600), motivoCredito);
      req.input('CriarCreditoCarteira', sql.Bit, opcaoReembolso === 'Credito' && valorDevolver > 0 ? 1 : 0);
      req.input('AgoraBrasil', sql.DateTime2(7), agoraBrasilDate());
    }, `
      SET NOCOUNT ON;
      SET XACT_ABORT ON;

      BEGIN TRAN;

        -- 1) Cancela créditos "de pacote" ainda disponíveis (mantém rastreabilidade)
        UPDATE dbo.CreditosPacientes
        SET
          Status = N'Cancelado',
          Motivo = CONCAT(
            COALESCE(NULLIF(Motivo, N''), N''),
            CASE WHEN Motivo IS NULL OR Motivo = N'' THEN N'' ELSE N' | ' END,
            @MotivoCancelamento
          )
        WHERE PacoteId = @PacoteId
          AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'Disponivel'
          AND UsadoEm IS NULL
          AND ConsultaId IS NULL;

        -- 2) (Opcional) cria crédito em carteira livre
        IF @CriarCreditoCarteira = 1
        BEGIN
          INSERT INTO dbo.CreditosPacientes
            (PacienteId, ConsultaId, Valor, Status, CriadoEm, UsadoEm, Motivo, PacoteId, OrigemPacoteId)
          VALUES
            (@PacienteId, NULL, @ValorCreditoCarteira, N'Disponivel', @AgoraBrasil, NULL, @MotivoCreditoCarteira, NULL, @PacoteId);
        END

        -- 3) Marca pacote como cancelado
        UPDATE dbo.Pacotes
        SET
          Status = N'Cancelado',
          CanceladoEm = @AgoraBrasil,
          GatewayStatus = @GatewayStatusCancelamento,
          GatewayRefundStatus = CASE
            WHEN @SolicitarReembolso = 0 THEN GatewayRefundStatus
            WHEN LTRIM(RTRIM(ISNULL(GatewayRefundStatus, N''))) IN (N'DONE', N'PARTIAL')
              THEN GatewayRefundStatus
            ELSE N'LOCAL_REQUESTED'
          END,
          GatewayRefundValor = CASE
            WHEN @SolicitarReembolso = 1 THEN @GatewayRefundValor
            ELSE GatewayRefundValor
          END,
          GatewayRefundDescricao = CASE
            WHEN @SolicitarReembolso = 1 THEN @GatewayRefundDescricao
            ELSE GatewayRefundDescricao
          END,
          GatewayRefundSolicitadoEm = CASE
            WHEN @SolicitarReembolso = 1 THEN COALESCE(GatewayRefundSolicitadoEm, @AgoraBrasil)
            ELSE GatewayRefundSolicitadoEm
          END,
          GatewayUltimoEvento = CASE
            WHEN @SolicitarReembolso = 1 THEN N'FISIOHELP_PACKAGE_REFUND_LOCAL_REQUESTED'
            ELSE GatewayUltimoEvento
          END,
          GatewayAtualizadoEm = CASE
            WHEN @SolicitarReembolso = 1 THEN @AgoraBrasil
            ELSE GatewayAtualizadoEm
          END,
          GatewayErroMensagem = CASE
            WHEN @SolicitarReembolso = 1 THEN NULL
            ELSE GatewayErroMensagem
          END
        WHERE Id = @PacoteId;

      COMMIT;
    `);

    await registrarCancelamentoLog({
      usuario,
      pacoteId: id,
      motivo: motivoUsuario ?? 'Cancelamento de pacote solicitado pelo usuario.',
      observacao: observacaoUsuario,
      origemAcao: 'pacotes.cancelar',
    });

    void notificacoesDispatch.pacoteCancelado({ pacoteId: id });

    if (opcaoReembolso === 'Reembolso') {
      try {
        const pacotePendente = await buscarPacotePorId(id, usuario);
        const recuperacao = await garantirReembolsoPacoteEnfileirado(
          pacotePendente,
          usuario
        );
        reembolsoGateway = recuperacao.fila;

        await queryWithContext(
          usuario,
          (req) => {
            req.input('PacoteId', sql.Int, id);
            req.input('GatewayStatus', sql.NVarChar(120), 'ReembolsoPendente');
          },
          `
            UPDATE dbo.Pacotes
            SET GatewayStatus = @GatewayStatus
            WHERE Id = @PacoteId
              AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'Cancelado';
          `
        );
      } catch (err) {
        await queryWithContext(
          usuario,
          (req) => {
            req.input('PacoteId', sql.Int, id);
            req.input('GatewayStatus', sql.NVarChar(120), 'ReembolsoFalhou');
          },
          `
            UPDATE dbo.Pacotes
            SET GatewayStatus = @GatewayStatus
            WHERE Id = @PacoteId
              AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'Cancelado';
          `
        ).catch(() => {});

        throw new HttpError(
          502,
          'Pacote cancelado, mas houve falha ao processar estorno no gateway. Tente novamente ou contate o suporte.'
        );
      }
    }

    const [atualizado, sumarioContrato] = await Promise.all([
      buscarPacotePorId(id, usuario),
      carregarSumarioContrato(usuario),
    ]);
    
    return {
      pacote: atualizado,
      sumarioContrato,
      cancelamento,
      opcaoReembolso,
      reembolsoGateway,
    };
  },

  async listar(usuario, { status, limit = 50, offset = 0 } = {}) {
    requireUser(usuario);

    const isPac = String(usuario.tipo || '').toLowerCase() === 'paciente';
    const isAdm = isAdmin(usuario);
    if (!isPac && !isAdm) throw new HttpError(403, 'Acesso negado.');

    const lim = Math.min(
      Math.max(Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 50, 1),
      200
    );
    const off = Math.max(
      Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 0,
      0
    );
    const statusNorm = status ? String(status).trim() : null;
    const pacienteId = isPac ? Number(usuario.id) : null;

    const r = await queryWithContext(usuario, (req) => {
      req.input('IsAdmin', sql.Bit, isAdm ? 1 : 0);
      req.input('PacienteId', sql.Int, Number.isFinite(pacienteId) ? pacienteId : null);
      req.input('Status', sql.NVarChar(60), statusNorm);
      req.input('Limit', sql.Int, lim);
      req.input('Offset', sql.Int, off);
    }, `
      SELECT COUNT(1) AS Total
      FROM dbo.Pacotes p
      WHERE
        (@IsAdmin = 1 OR p.PacienteId = @PacienteId)
        AND (@Status IS NULL OR p.Status = @Status);

      ;WITH Page AS (
        SELECT
          p.Id,
          p.FisioterapeutaId,
          p.EspecialidadeId,
          p.NomePacote AS Nome,
          p.QuantidadeConsultas,
          ISNULL(p.ConsultasUtilizadas, 0) AS ConsultasUtilizadas,
          CAST(p.ValorTotal AS DECIMAL(10,2)) AS ValorTotal,
          CAST(ISNULL(p.ValorPago, 0) AS DECIMAL(10,2)) AS ValorPago,
          p.DataCompra,
          p.Validade,
          p.Status,
          p.CriadoEm,
          p.PagoEm,
          p.CanceladoEm
        FROM dbo.Pacotes p
        WHERE
          (@IsAdmin = 1 OR p.PacienteId = @PacienteId)
          AND (@Status IS NULL OR p.Status = @Status)
        ORDER BY p.CriadoEm DESC, p.Id DESC
        OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY
      )
      SELECT
        p.Id,
        p.FisioterapeutaId,
        f.Nome AS NomeFisioterapeuta,
        p.EspecialidadeId,
        COALESCE(e.Nome, f.Especialidade) AS EspecialidadeFisioterapeuta,
        p.Nome,
        p.QuantidadeConsultas,
        p.ConsultasUtilizadas,
        p.ValorTotal,
        p.ValorPago,
        p.DataCompra,
        p.Validade,
        p.Status,
        p.CriadoEm,
        p.PagoEm,
        p.CanceladoEm
      FROM Page p
      LEFT JOIN dbo.Fisioterapeutas f
        ON f.Id = p.FisioterapeutaId
      LEFT JOIN dbo.Especialidades e
        ON e.Id = p.EspecialidadeId
      ORDER BY p.CriadoEm DESC, p.Id DESC;
    `);

    return {
      total: r?.recordsets?.[0]?.[0]?.Total ?? 0,
      limit: lim,
      offset: off,
      itens: r?.recordsets?.[1] ?? [],
    };
  },

};

export default pacotesService;
