//  services/consultasService.js
import PDFDocument from 'pdfkit';
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { registrarCancelamentoLog } from './cancelamentosLogService.js';
import { reconciliarCreditoPacoteDisponivelPorConsulta } from './_reconciliarCreditoPacoteDisponivel.js';
import reembolsosGatewayFilaService from './reembolsosGatewayFilaService.js';
import {
  obterPendenciaAvaliacaoFisioterapeuta,
  obterPendenciaAvaliacaoPaciente,
} from './avaliacoesService.js';
import { HttpError } from '../utils/httpError.js';
import { log } from '../config/logger.js';

/**
 * Executa uma query garantindo SESSION_CONTEXT no MESMO batch/Request.
 * Isso evita o problema do pool do mssql "trocar" de conexão entre requests.
 */

function asTipo(usuario) {
  return String(usuario?.tipo || '').toLowerCase();
}
function isAdmin(usuario) {
  return asTipo(usuario) === 'admin';
}
function isFisio(usuario) {
  return asTipo(usuario) === 'fisioterapeuta';
}
function isPaciente(usuario) {
  return asTipo(usuario) === 'paciente';
}

function requireUser(usuario) {
  if (!usuario?.id || !usuario?.tipo) throw new HttpError(401, 'Não autenticado.');
}

function assertId(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} inválido.`);
  return n;
}

// Converte uma string ISO (com ou sem offset) para um Date em UTC, mantendo o "wall time".
// Ex.: '2026-01-19T10:00:00-03:00' => Date.UTC(2026-01-19 10:00:00) (evita shift do driver mssql quando useUTC=true)
function parseLocalIsoToUtcNaive(value, fieldName = 'DataHora') {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new HttpError(400, `${fieldName} inválida.`);
    return value;
  }

  if (typeof value === 'string') {
    const s = value.trim();
    // Captura YYYY-MM-DDTHH:mm[:ss] e ignora o restante (offset/Z)
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      const hour = Number(m[4]);
      const minute = Number(m[5]);
      const second = Number(m[6] ?? '0');

      const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
      if (Number.isNaN(d.getTime())) throw new HttpError(400, `${fieldName} inválida.`);
      return d;
    }
  }

  // fallback: tenta parse nativo
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${fieldName} inválida.`);
  return d;
}

function ensureAgendamentoAPartirDeAmanha(isoLike, fieldName = 'DataHora') {
  const s = String(isoLike ?? '').trim();
  if (!s) throw new HttpError(400, `${fieldName} é obrigatório.`);

  // Preferimos comparar por "dia" (YYYY-MM-DD) para evitar confusão de timezone.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  let dia = m ? m[1] : null;

  if (!dia) {
    const dt = new Date(s);
    if (Number.isNaN(dt.getTime())) throw new HttpError(400, `${fieldName} inválida.`);
    const y = dt.getFullYear();
    const mo = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    dia = `${y}-${mo}-${d}`;
  }

  const now = new Date();
  const amanha = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const y2 = amanha.getFullYear();
  const mo2 = String(amanha.getMonth() + 1).padStart(2, '0');
  const d2 = String(amanha.getDate()).padStart(2, '0');
  const minDia = `${y2}-${mo2}-${d2}`;

  if (dia < minDia) {
    throw new HttpError(400, 'Não é permitido agendar para o mesmo dia ou dias no passado. Selecione a partir de amanhã.');
  }
}


function normalizeText(v, maxLen = 500) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function parseNumber(v, field, { min = null, max = null } = {}) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} inválido.`);
  if (min !== null && n < min) throw new HttpError(400, `${field} inválido (min ${min}).`);
  if (max !== null && n > max) throw new HttpError(400, `${field} inválido (max ${max}).`);
  return n;
}

function parseBooleanish(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'sim', 'yes'].includes(normalized)) return true;
    if (['0', 'false', 'nao', 'não', 'no', ''].includes(normalized)) return false;
  }
  return false;
}


function montarEnderecoCompleto(endereco, cep, cidade, estado) {
  const parts = [endereco, cep, cidade, estado]
    .map((v) => (v ?? '').toString().trim())
    .filter(Boolean);
  return parts.join(', ');
}

function buildNavigationLinks(enderecoCompleto) {
  if (!enderecoCompleto) {
    return { googleMaps: null, waze: null };
  }
  const q = encodeURIComponent(enderecoCompleto);
  return {
    googleMaps: `https://www.google.com/maps/search/?api=1&query=${q}`,
    waze: `https://waze.com/ul?q=${q}&navigate=yes`
  };
}

function enrichConsultaComEnderecos(row) {
  if (!row) return row;

  // Preferência: Residencial se existir, senão Comercial
  const usandoResidencial = !!(row.PacienteEnderecoResidencial && String(row.PacienteEnderecoResidencial).trim());

  const enderecoPreferencial = usandoResidencial
    ? String(row.PacienteEnderecoResidencial).trim()
    : ((row.PacienteEnderecoComercial && String(row.PacienteEnderecoComercial).trim())
        ? String(row.PacienteEnderecoComercial).trim()
        : null);

  const complementoPreferencial = usandoResidencial
    ? (row.PacienteComplementoResidencial ? String(row.PacienteComplementoResidencial).trim() : null)
    : (row.PacienteComplementoComercial ? String(row.PacienteComplementoComercial).trim() : null);

  const bairroPreferencial = usandoResidencial
    ? (row.PacienteBairroResidencial ? String(row.PacienteBairroResidencial).trim() : null)
    : (row.PacienteBairroComercial ? String(row.PacienteBairroComercial).trim() : null);

  // Links de navegação usam o endereço completo (endereço + CEP/cidade/estado)
  const enderecoCompleto = montarEnderecoCompleto(
    enderecoPreferencial,
    bairroPreferencial,
    row.PacienteCep,
    row.PacienteCidade,
    row.PacienteEstado
  );

  const linksPref = buildNavigationLinks(enderecoCompleto);

  const {
    PacienteEnderecoResidencial,
    PacienteComplementoResidencial,
    PacienteEnderecoComercial,
    PacienteComplementoComercial,
    PacienteBairroResidencial,
    PacienteBairroComercial,
    ...rest
  } = row;

  return {
    ...rest,
    PacienteEnderecoPreferencial: enderecoPreferencial,
    PacienteBairroPreferencial: bairroPreferencial || null,
    PacienteComplementoPreferencial: complementoPreferencial || null,
    RotaGoogleMaps: linksPref.googleMaps,
    RotaWaze: linksPref.waze
  };
}

function formatConsultaPacienteList(row) {
  if (!row) return row;
  return {
    Id: row.Id,
    PacienteId: row.PacienteId,
    FisioterapeutaId: row.FisioterapeutaId,
    NomeFisioterapeuta: row.NomeFisioterapeuta,
    EspecialidadeId: row.EspecialidadeId ?? null,
    EspecialidadeFisioterapeuta: row.EspecialidadeFisioterapeuta ?? row.Especialidade ?? null,
    ToleranciaCancelamentoMinutos: row.ToleranciaCancelamentoMinutos ?? null,
    PacienteNome: row.PacienteNome,
    DataHora: formatSqlLocalDateTime(row.DataHora),
    Status: row.Status,
    ValorConsulta: row.ValorConsulta,
    StatusPagamento: row.StatusPagamento,
    PagamentoViaPlataforma: row.PagamentoViaPlataforma,
    TemTransacaoPaga: row.TemTransacaoPaga ?? false,
    PagoComPacote: row.PagoComPacote ?? false,
    MetodoPagamentoTransacao: row.MetodoPagamentoTransacao ?? null,
    PacienteCPFValido: row.PacienteCPFValido ?? null,
    PacienteEmailVerificado: row.PacienteEmailVerificado ?? null,
    PacienteTelefoneVerificado: row.PacienteTelefoneVerificado ?? null,
    PacienteContaVerificada: row.PacienteContaVerificada ?? null,
    TentativasInvalidasToken: row.TentativasInvalidasToken ?? null,
    MaxTentativasToken: row.MaxTentativasToken ?? null,
    LimiteTentativasTokenAtingido: row.LimiteTentativasTokenAtingido ?? false,
    ConfirmadaPor: row.ConfirmadaPor,
    ConfirmadaEm: formatSqlLocalDateTime(row.ConfirmadaEm),
    DataEncerramento: formatSqlLocalDateTime(row.DataEncerramento),
    MotivoEncerramento: row.MotivoEncerramento,
    DataContestacao: formatSqlLocalDateTime(row.DataContestacao ?? null)
  };
}

function formatConsultaPacienteDetalhe(row) {
  if (!row) return row;
  const tokenGeradoEm = row.TokenGeradoEm ?? row.tokenGeradoEm ?? null;
  const tokenExpiraEm =
    row.TokenExpiraEm ??
    row.tokenExpiraEm ??
    getTokenExpirationParts(row);

  return {
    ...formatConsultaPacienteList(row),
    DenunciaJaRegistrada: row.DenunciaJaRegistrada ?? false,
    TemTransacaoPaga: row.TemTransacaoPaga ?? false,
    ChatLiberado: row.ChatLiberado,
    ChatLiberadoEm: formatSqlLocalDateTime(row.ChatLiberadoEm),
    CheckinLatitude: row.CheckinLatitude,
    CheckinLongitude: row.CheckinLongitude,
    CheckinHora: formatSqlLocalDateTime(row.CheckinHora),
    TokenValidacao: row.TokenValidacao,
    TokenGeradoEm: formatSqlLocalDateTime(tokenGeradoEm),
    TokenExpiraEm: formatSqlLocalDateTime(tokenExpiraEm),
    ConfirmacaoAtendimento: row.ConfirmacaoAtendimento,
    DataContestacao: formatSqlLocalDateTime(row.DataContestacao),
    EvidenciaCheckin: row.EvidenciaCheckin,
    DataCheckin: formatSqlLocalDateTime(row.DataCheckin),
    DataEncerramento: formatSqlLocalDateTime(row.DataEncerramento),
    MotivoEncerramento: row.MotivoEncerramento
  };
}

function formatConsultaFisioDetalhe(row) {
  if (!row) return row;

  // Remover campos internos que não fazem sentido no "Detalhe da consulta" para o fisioterapeuta
  // (pagamento/origem e nome do próprio fisio)
  const {
    PagamentoViaPlataforma,
    OrigemAgendamento,
    IsentoTaxaServico,
    IsentoIntermediacao,
    OrigemPagamento,
    NomeFisioterapeuta,
    ...rest
  } = row;

  const avaliacoesPaciente = parseJsonArraySafe(row.AvaliacoesPacienteJson).map((item) => ({
    ...item,
    DataAvaliacao: formatSqlLocalDateTime(item?.DataAvaliacao ?? null),
  }));

  return {
    ...rest,
    PagoForaPlataforma: PagamentoViaPlataforma === false || PagamentoViaPlataforma === 0 ? true : false,
    AvaliacoesPaciente: avaliacoesPaciente,
    AvaliacoesPacienteResumo: {
      Total: Number(row.AvaliacoesPacienteTotal ?? avaliacoesPaciente.length ?? 0),
      NotaMedia:
        row.AvaliacoesPacienteNotaMedia != null
          ? Number(row.AvaliacoesPacienteNotaMedia)
          : null,
    },
  };
}

async function prepararCancelamentoReembolsoAsaasArrependimento(consultaId, pacienteId, motivo, usuario) {
  const result = await queryWithContext(usuario, (req) => {
    req.input('ConsultaId', sql.Int, consultaId);
    req.input('PacienteId', sql.Int, pacienteId);
    req.input('Motivo', sql.NVarChar(400), motivo);
  }, `
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRY
      BEGIN TRAN;

      DECLARE
        @FisioterapeutaId INT = NULL,
        @Status NVARCHAR(60) = NULL,
        @StatusPagamento NVARCHAR(100) = NULL,
        @DataHora DATETIME = NULL,
        @CheckinHora DATETIME = NULL,
        @Token NVARCHAR(30) = NULL,
        @Confirmacao BIT = 0,
        @PagamentoViaPlataforma BIT = 0,
        @OrigemPagamento NVARCHAR(100) = NULL,
        @TransacaoId INT = NULL,
        @MetodoPagamento NVARCHAR(40) = NULL,
        @DataCompra DATETIME = NULL,
        @MotivoBase NVARCHAR(200) = N'Cancelamento solicitado pelo paciente com reembolso Asaas',
        @MotivoEnc NVARCHAR(400) = COALESCE(NULLIF(@Motivo, N''), N'Cancelamento solicitado pelo paciente com reembolso Asaas');

      SELECT
        @FisioterapeutaId = c.FisioterapeutaId,
        @Status = LTRIM(RTRIM(ISNULL(c.Status, N''))),
        @StatusPagamento = LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))),
        @DataHora = c.DataHora,
        @CheckinHora = c.CheckinHora,
        @Token = c.TokenValidacao,
        @Confirmacao = ISNULL(c.ConfirmacaoAtendimento, 0),
        @PagamentoViaPlataforma = ISNULL(c.PagamentoViaPlataforma, 0),
        @OrigemPagamento = LTRIM(RTRIM(ISNULL(c.OrigemPagamento, N'')))
      FROM dbo.Consultas c WITH (UPDLOCK, HOLDLOCK)
      WHERE c.Id = @ConsultaId
        AND c.PacienteId = @PacienteId;

      IF @FisioterapeutaId IS NULL
        THROW 51200, 'Consulta não encontrada para este paciente.', 1;

      IF @Status IN (N'Cancelada', N'Concluída', N'Concluida', N'Paciente Ausente', N'Fisioterapeuta Ausente')
        THROW 51201, 'Consulta não pode mais ser cancelada neste status.', 1;

      IF @CheckinHora IS NOT NULL OR @Token IS NOT NULL OR @Confirmacao = 1
        THROW 51202, 'Não é possível arrependimento após início do atendimento.', 1;

      IF @DataHora IS NULL
        THROW 51203, 'DataHora da consulta inválida.', 1;

      DECLARE @ToleranciaCancelamentoMinutos INT = 0;
      SELECT @ToleranciaCancelamentoMinutos = ISNULL(f.ToleranciaCancelamentoMinutos, 0)
      FROM dbo.Fisioterapeutas f WITH (READCOMMITTEDLOCK)
      WHERE f.Id = @FisioterapeutaId;

      IF @ToleranciaCancelamentoMinutos < 0 SET @ToleranciaCancelamentoMinutos = 0;
      IF SYSDATETIME() >= DATEADD(MINUTE, -@ToleranciaCancelamentoMinutos, @DataHora)
        THROW 51204, 'Cancelamento só é permitido antes da data/hora agendada ou antes da tolerência definida pelo fisioterapeuta.', 1;

      IF @PagamentoViaPlataforma <> 1 OR @OrigemPagamento <> N'Plataforma'
        THROW 51205, 'Reembolso Asaas indisponível para pagamento fora da plataforma.', 1;

      IF @StatusPagamento <> N'Pago'
        THROW 51206, 'Arrependimento com reembolso só é permitido quando StatusPagamento = Pago.', 1;

      SELECT TOP (1)
        @TransacaoId = t.Id,
        @MetodoPagamento = LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N''))),
        @DataCompra = COALESCE(t.DataConfirmacao, t.DataCriacao)
      FROM dbo.Transacoes t WITH (UPDLOCK, HOLDLOCK)
      WHERE t.ConsultaId = @ConsultaId
        AND t.PacienteId = @PacienteId
        AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago'
      ORDER BY t.Id DESC;

      IF @TransacaoId IS NULL
        THROW 51207, 'Não existe transação paga para reembolso Asaas.', 1;

      IF @MetodoPagamento IN (N'Pacote', N'CreditoCarteira')
        THROW 51208, 'Reembolso Asaas indisponível para pacote ou crédito em carteira.', 1;

      IF @DataCompra IS NULL
        THROW 51209, 'Não foi possível determinar a data da compra na transação.', 1;

      IF SYSDATETIME() > DATEADD(DAY, 7, @DataCompra)
        THROW 51210, 'Fora do prazo de 7 dias do arrependimento.', 1;

      UPDATE dbo.Consultas
      SET Status = N'Cancelada',
          DataEncerramento = COALESCE(DataEncerramento, SYSDATETIME()),
          MotivoEncerramento = COALESCE(NULLIF(@Motivo, N''), MotivoEncerramento, @MotivoBase),
          ChatLiberado = 0,
          ChatLiberadoEm = NULL
      WHERE Id = @ConsultaId
        AND PacienteId = @PacienteId;

      IF OBJECT_ID('dbo.ChatsAtivos', 'U') IS NOT NULL
      BEGIN
        UPDATE dbo.ChatsAtivos
        SET Ativo = 0
        WHERE ConsultaId = @ConsultaId
          AND Ativo = 1;
      END

      IF OBJECT_ID('dbo.Repasses', 'U') IS NOT NULL
      BEGIN
        UPDATE dbo.Repasses
        SET Status = N'Cancelado'
        WHERE TransacaoId = @TransacaoId
          AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'Pendente';
      END

      UPDATE dbo.Transacoes
      SET GatewayProvider = COALESCE(GatewayProvider, N'asaas'),
          GatewayRefundStatus = CASE
            WHEN LTRIM(RTRIM(ISNULL(GatewayRefundStatus, N''))) IN (N'PENDING', N'REQUESTED', N'IN_PROGRESS')
              THEN GatewayRefundStatus
            ELSE N'LOCAL_REQUESTED'
          END,
          GatewayRefundDescricao = LEFT(@MotivoEnc, 500),
          GatewayRefundSolicitadoEm = COALESCE(GatewayRefundSolicitadoEm, SYSDATETIME()),
          GatewayUltimoEvento = N'FISIOHELP_CANCELAMENTO_ARREPENDIMENTO',
          GatewayAtualizadoEm = SYSDATETIME(),
          GatewayErroMensagem = NULL
      WHERE Id = @TransacaoId;

      IF OBJECT_ID('dbo.LogsFinanceiros', 'U') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM dbo.LogsFinanceiros WITH (READCOMMITTEDLOCK)
          WHERE TransacaoId = @TransacaoId
            AND LTRIM(RTRIM(ISNULL(Acao, N''))) = N'Pendente'
            AND Observacao LIKE N'Solicitação de estorno Asaas%'
        )
      BEGIN
        INSERT INTO dbo.LogsFinanceiros (TransacaoId, RepasseId, Usuario, Acao, DataAcao, Observacao)
        VALUES (
          @TransacaoId,
          NULL,
          N'Sistema',
          N'Pendente',
          SYSDATETIME(),
          LEFT(CONCAT(N'Solicitação de estorno Asaas | ', @MotivoEnc), 500)
        );
      END

      COMMIT;

      SELECT
        CAST(1 AS bit) AS Sucesso,
        @ConsultaId AS ConsultaId,
        @PacienteId AS PacienteId,
        @TransacaoId AS TransacaoId,
        N'Reembolso' AS OpcaoReembolso,
        @DataCompra AS DataCompra,
        CAST(1 AS bit) AS PagamentoViaPlataforma,
        CAST(0 AS bit) AS SemReembolso,
        N'Consulta cancelada. Estorno Asaas solicitado ao gateway.' AS Mensagem;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0 ROLLBACK;
      THROW;
    END CATCH
  `);

  return result?.recordset?.[0] ?? null;
}

async function cancelarConsultaPagaComCreditoLivre(consultaId, pacienteId, motivo, usuario) {
  try {
    const result = await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, consultaId);
      req.input('PacienteId', sql.Int, pacienteId);
      req.input('Motivo', sql.NVarChar(400), motivo);
    }, `
      BEGIN TRY
        BEGIN TRAN;

        DECLARE @Status NVARCHAR(60) = NULL;
        DECLARE @StatusPg NVARCHAR(60) = NULL;
        DECLARE @ViaPlataforma BIT = 0;
        DECLARE @Valor DECIMAL(10,2) = 0;
        DECLARE @MotivoMaxBytes INT = COL_LENGTH('dbo.CreditosPacientes', 'Motivo');
        DECLARE @MotivoMaxChars INT = CASE
          WHEN @MotivoMaxBytes IS NULL OR @MotivoMaxBytes <= 0 THEN 400
          ELSE (@MotivoMaxBytes / 2)
        END;

        SELECT
          @Status = LTRIM(RTRIM(ISNULL(c.Status, N''))),
          @StatusPg = LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))),
          @ViaPlataforma = ISNULL(c.PagamentoViaPlataforma, 0),
          @Valor = TRY_CONVERT(DECIMAL(10,2), c.ValorConsulta)
        FROM dbo.Consultas c WITH (UPDLOCK, HOLDLOCK)
        WHERE c.Id = @ConsultaId
          AND c.PacienteId = @PacienteId;

        IF @Status IS NULL
          THROW 50030, 'Consulta não encontrada para este paciente.', 1;

        IF @Status IN (N'Cancelada', N'Concluída', N'Paciente Ausente', N'Fisioterapeuta Ausente')
          THROW 50031, 'Consulta não pode mais ser cancelada neste status.', 1;

        IF @ViaPlataforma <> 1
          THROW 50032, 'Crédito não aplicável: PagamentoViaPlataforma=0.', 1;

        IF @StatusPg NOT IN (N'Pago', N'CreditoPaciente')
          THROW 50023, 'Crédito só é permitido quando StatusPagamento = "Pago" ou "CreditoPaciente".', 1;

        IF NOT EXISTS (
          SELECT 1
          FROM dbo.CreditosPacientes cp WITH (UPDLOCK, HOLDLOCK)
          WHERE cp.PacienteId = @PacienteId
            AND cp.ConsultaId = @ConsultaId
            AND cp.PacoteId IS NULL
        )
          THROW 50033, 'Esta consulta não foi paga com crédito na carteira.', 1;

        DECLARE @MotivoCredito NVARCHAR(4000) = CONCAT(
          N'Cancelamento solicitado pelo paciente',
          CASE
            WHEN NULLIF(LTRIM(RTRIM(ISNULL(@Motivo, N''))), N'') IS NULL THEN N''
            ELSE CONCAT(N' | ', LEFT(LTRIM(RTRIM(@Motivo)), 250))
          END
        );
        SET @MotivoCredito = LEFT(@MotivoCredito, @MotivoMaxChars);

        IF EXISTS (
          SELECT 1
          FROM dbo.CreditosPacientes cp WITH (UPDLOCK, HOLDLOCK)
          WHERE cp.PacienteId = @PacienteId
            AND cp.PacoteId IS NULL
            AND (
              cp.ConsultaId = @ConsultaId
              OR (cp.OrigemConsultaId = @ConsultaId AND cp.ConsultaId IS NULL)
            )
            AND LTRIM(RTRIM(ISNULL(cp.Status, N''))) = N'Disponivel'
        )
        BEGIN
          UPDATE dbo.CreditosPacientes
            SET Valor = COALESCE(@Valor, Valor),
                OrigemConsultaId = CASE
                  WHEN OrigemConsultaId IS NULL
                   AND OrigemPacoteId IS NULL
                   AND PacoteId IS NULL
                  THEN @ConsultaId
                  ELSE OrigemConsultaId
                END,
                ConsultaId = NULL,
                Motivo = @MotivoCredito
          WHERE PacienteId = @PacienteId
            AND PacoteId IS NULL
            AND (
              ConsultaId = @ConsultaId
              OR (OrigemConsultaId = @ConsultaId AND ConsultaId IS NULL)
            )
            AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'Disponivel';
        END
        ELSE
        BEGIN
          UPDATE dbo.CreditosPacientes
            SET Status = N'Disponivel',
                UsadoEm = NULL,
                Valor = COALESCE(@Valor, Valor),
                OrigemConsultaId = CASE
                  WHEN OrigemConsultaId IS NULL
                   AND OrigemPacoteId IS NULL
                   AND PacoteId IS NULL
                  THEN ConsultaId
                  ELSE OrigemConsultaId
                END,
                ConsultaId = NULL,
                Motivo = @MotivoCredito
          WHERE PacienteId = @PacienteId
            AND ConsultaId = @ConsultaId
            AND PacoteId IS NULL;

          IF @@ROWCOUNT = 0
          BEGIN
            INSERT INTO dbo.CreditosPacientes (PacienteId, ConsultaId, OrigemConsultaId, Valor, Status, UsadoEm, Motivo)
            VALUES (@PacienteId, NULL, @ConsultaId, COALESCE(@Valor, 0), N'Disponivel', NULL, @MotivoCredito);
          END
        END

        DECLARE @TransacaoId INT = NULL, @TransacaoStatus NVARCHAR(60) = NULL, @MetodoPagamentoTransacao NVARCHAR(40) = NULL;

        SELECT TOP (1)
          @TransacaoId = t.Id,
          @TransacaoStatus = LTRIM(RTRIM(ISNULL(t.Status, N''))),
          @MetodoPagamentoTransacao = LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N'')))
        FROM dbo.Transacoes t WITH (UPDLOCK, HOLDLOCK)
        WHERE t.ConsultaId = @ConsultaId
          AND t.PacienteId = @PacienteId
          AND LTRIM(RTRIM(ISNULL(t.Status, N''))) IN (N'Pago', N'Reembolsado')
        ORDER BY t.Id DESC;

        IF @TransacaoId IS NOT NULL
        BEGIN
          IF OBJECT_ID('dbo.Repasses', 'U') IS NOT NULL
          BEGIN
            UPDATE dbo.Repasses
              SET Status = N'Cancelado'
            WHERE TransacaoId = @TransacaoId
              AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'Pendente';
          END

          IF @TransacaoStatus = N'Pago'
          BEGIN
            UPDATE dbo.Transacoes
              SET Status = N'Reembolsado'
            WHERE Id = @TransacaoId;
          END
        END

        UPDATE dbo.Consultas
          SET Status = N'Cancelada',
              StatusPagamento = N'CreditoPaciente',
              DataEncerramento = COALESCE(DataEncerramento, SYSDATETIME()),
              MotivoEncerramento = COALESCE(NULLIF(@Motivo, N''), MotivoEncerramento, N'Cancelamento solicitado pelo paciente'),
              ChatLiberado = 0,
              ChatLiberadoEm = NULL
        WHERE Id = @ConsultaId
          AND PacienteId = @PacienteId;

        COMMIT;

        SELECT
          CAST(1 AS bit) AS Sucesso,
          @ConsultaId AS ConsultaId,
          N'Credito' AS OpcaoReembolso,
          CAST(NULL AS DATETIME) AS DataCompra,
          CAST(1 AS bit) AS PagamentoViaPlataforma,
          CAST(0 AS bit) AS SemReembolso,
          N'Consulta cancelada e valor devolvido como crédito na plataforma.' AS Mensagem;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH;
    `);

    return result?.recordset?.[0] ?? null;
  } catch (err) {
    const message = String(err?.message || '').trim();

    if (message.includes('Consulta não encontrada')) {
      throw new HttpError(404, message);
    }

    if (
      message.includes('Fora do prazo de 7 dias do arrependimento') ||
      message.includes('Não foi possível determinar a data de compra') ||
      message.includes('não pode mais ser cancelada') ||
      message.includes('Crédito não aplicável') ||
      message.includes('Crédito só é permitido') ||
      message.includes('não foi paga com crédito na carteira')
    ) {
      throw new HttpError(409, message);
    }

    throw err;
  }
}


/**
 * Status suportados:
 * 'Aguardando' | 'Confirmada' | 'Concluída' | 'Cancelada'
 */
const STATUS = {
  AGUARDANDO: 'Aguardando',
  CONFIRMADA: 'Confirmada',
  CONCLUIDA: 'Concluída',
  CANCELADA: 'Cancelada',
  PACIENTE_AUSENTE: 'Paciente Ausente',
  FISIOTERAPEUTA_AUSENTE: 'Fisioterapeuta Ausente'
};

function isTerminalStatus(s) {
  return [
    STATUS.CANCELADA,
    STATUS.CONCLUIDA,
    STATUS.PACIENTE_AUSENTE,
    STATUS.FISIOTERAPEUTA_AUSENTE,
  ].includes(String(s || ''));
}

const DEFAULT_DURACAO_MIN = 60;
const TOKEN_EXPIRACAO_MIN = 10;
const CHECKIN_ANTECEDENCIA_MIN = 10;
const APP_TIME_ZONE = 'America/Sao_Paulo';

function formatDateTimePtBr(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'data/hora inválida';
  return date.toLocaleString('pt-BR', {
    timeZone: APP_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function pad3(value) {
  return String(value).padStart(3, '0');
}

function extractSqlLocalDateTimeParts(value) {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
      hour: value.getUTCHours(),
      minute: value.getUTCMinutes(),
      second: value.getUTCSeconds(),
      millisecond: value.getUTCMilliseconds(),
    };
  }

  if (typeof value === 'object') {
    const year = Number(value.year);
    const month = Number(value.month);
    const day = Number(value.day);
    const hour = Number(value.hour);
    const minute = Number(value.minute);
    const second = value.second === undefined ? 0 : Number(value.second);
    const millisecond = value.millisecond === undefined ? 0 : Number(value.millisecond);

    if (
      Number.isFinite(year) &&
      Number.isFinite(month) &&
      Number.isFinite(day) &&
      Number.isFinite(hour) &&
      Number.isFinite(minute) &&
      Number.isFinite(second) &&
      Number.isFinite(millisecond)
    ) {
      return {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millisecond,
      };
    }
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,7}))?/
  );
  if (!match) return null;

  const fraction = String(match[7] ?? '').padEnd(3, '0').slice(0, 3);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? '0'),
    millisecond: Number(fraction || '0'),
  };
}

function localDateTimePartsToNaiveTimestamp(parts) {
  if (!parts) return Number.NaN;
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0,
    parts.millisecond ?? 0
  );
}

function addMinutesToSqlLocalDateTime(value, minutes) {
  const parts = extractSqlLocalDateTimeParts(value);
  if (!parts) return null;
  const shifted = new Date(localDateTimePartsToNaiveTimestamp(parts) + minutes * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
}

function formatSqlLocalDateTime(value) {
  const parts = extractSqlLocalDateTimeParts(value);
  if (!parts) return null;
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}.${pad3(parts.millisecond)}`;
}

function formatSqlDateBR(value) {
  const parts = extractSqlLocalDateTimeParts(value);
  if (!parts) return '-';
  return `${pad2(parts.day)}/${pad2(parts.month)}/${parts.year}`;
}

function calcularIdadeNaData(dataNascimento, dataReferencia) {
  const nasc = extractSqlLocalDateTimeParts(dataNascimento);
  const ref = extractSqlLocalDateTimeParts(dataReferencia);
  if (!nasc || !ref) return null;

  let idade = ref.year - nasc.year;
  const antesDoAniversario =
    ref.month < nasc.month ||
    (ref.month === nasc.month && ref.day < nasc.day);

  if (antesDoAniversario) idade -= 1;
  return idade >= 0 ? idade : null;
}

function safeFilenamePart(value, fallback = 'arquivo') {
  const normalized = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return normalized || fallback;
}

function formatarCrefitoNumeroTermo(valor, estado = 'SP') {
  const digits = String(valor ?? '').replace(/\D/g, '');
  if (!digits) return '-';

  const uf = String(estado || 'SP').trim().toUpperCase();
  return `${digits}-F /${uf}`;
}

function gerarTermoConsentimentoPdfBuffer(dados) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    let settled = false;

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    const W = doc.page.width - 96;
    const PRIMARY = '#F46337';
    const DARK = '#1A1A1A';
    const MUTED = '#6B7280';
    const BORDER = '#E5E7EB';
    const BG_CARD = '#FFF9EE';
    const FOOTER_TEXT =
      'Este Termo de Consentimento Informado foi disponibilizado pela plataforma FisioHelp como ferramenta de apoio ao profissional. ' +
      'O preenchimento, a obtenção das assinaturas e a guarda do documento original são de inteira responsabilidade do fisioterapeuta. ' +
      'A FisioHelp não se responsabiliza pelo conteúdo clínico nem pela validade jurídica do documento.';
    const FOOTER_HEIGHT = 86;
    const FOOTER_TOP = doc.page.height - FOOTER_HEIGHT;
    const CONTENT_BOTTOM = FOOTER_TOP - 14;

    function drawFooter() {
      const prevY = doc.y;
      doc.save();
      doc.moveTo(48, FOOTER_TOP).lineTo(48 + W, FOOTER_TOP).strokeColor(BORDER).stroke();
      doc
        .fillColor(MUTED)
        .fontSize(8)
        .font('Helvetica')
        .text(FOOTER_TEXT, 48, FOOTER_TOP + 8, {
          width: W,
          height: FOOTER_HEIGHT - 16,
          align: 'center',
        });
      doc.restore();
      doc.y = prevY;
    }

    function ensureSpace(requiredHeight = 40) {
      if (doc.y + requiredHeight <= CONTENT_BOTTOM) return;
      doc.addPage();
      doc.y = 52;
      doc.fillColor(DARK);
    }

    function labeledLine(label, value, x, y, width) {
      doc
        .fillColor(MUTED)
        .fontSize(8)
        .font('Helvetica')
        .text(label, x, y, { width });
      doc
        .fillColor(DARK)
        .fontSize(10)
        .font('Helvetica-Bold')
        .text(value || '-', x, y + 14, { width });
    }

    function fieldText(label, value, options = {}) {
      const x = options.x ?? 48;
      const y = options.y ?? doc.y;
      const labelText = `${label}: `;
      doc
        .fillColor(DARK)
        .fontSize(10)
        .font('Helvetica-Bold')
        .text(labelText, x, y, { continued: true });
      doc
        .font('Helvetica')
        .text(value || '-', { width: W - doc.widthOfString(labelText) });
      doc.moveDown(options.moveDown ?? 0.55);
    }

    doc.on('pageAdded', () => {
      drawFooter();
    });

    doc.rect(48, 40, W, 56).fill(PRIMARY);
    doc
      .fillColor('#FFFFFF')
      .fontSize(20)
      .font('Helvetica-Bold')
      .text('FisioHelp', 64, 52, { width: W - 32 });
    doc
      .fontSize(10)
      .font('Helvetica')
      .text('Termo de Consentimento Informado', 64, 76, { width: W - 32 });

    doc.y = 112;
    drawFooter();

    const idY = doc.y + 8;
    doc.rect(48, idY, W, 54).fill(BG_CARD).stroke(BORDER);
    const colW = W / 3;
    labeledLine('Consulta', String(dados.consultaId), 60, idY + 9, colW - 20);
    labeledLine('Data da consulta', dados.dataConsulta, 60 + colW, idY + 9, colW - 20);
    labeledLine('Profissional', dados.fisioCrefito, 60 + (colW * 2), idY + 9, colW - 20);

    doc.y = idY + 76;

    ensureSpace(52);
    doc
      .fillColor(DARK)
      .font('Helvetica-Bold')
      .fontSize(15)
      .text('TERMO DE CONSENTIMENTO INFORMADO', 48, doc.y, { width: W, align: 'center' });
    doc.moveDown(0.35);
    doc
      .fontSize(11)
      .text(dados.fisioNome || '-', 48, doc.y, { width: W, align: 'center' });
    doc.moveDown(1.25);

    ensureSpace(102);
    fieldText('Nome do paciente', dados.pacienteNome);
    const nascY = doc.y;
    fieldText('Data de nascimento', dados.dataNascimento, { x: 48, y: nascY, moveDown: 0 });
    fieldText('Idade', dados.idade ?? '-', { x: 310, y: nascY });
    fieldText('Nome do responsável legal', '_______________________________________________');
    fieldText('Procedimento fisioterapêutico', dados.procedimentoFisioterapeutico);
    const profY = doc.y;
    fieldText('Nome do profissional', dados.fisioNome, { x: 48, y: profY, moveDown: 0 });
    fieldText('CREFITO nº', dados.fisioCrefito, { x: 330, y: profY });
    doc.moveDown(1.15);

    const termo =
      'DECLARO estando em pleno gozo de minhas faculdades mentais, que fui previamente informado por meu/minha Fisioterapeuta, acerca do meu estado de saúde funcional, bem como declaro, também, que recebi deste(a) todos os esclarecimentos necessários no que se refere ao diagnóstico fisioterapêutico e/ou os objetivos da assistência fisioterapêutica para o tratamento ao qual irei me submeter. DECLARO, ainda, ter sido informado(a), de forma clara acerca da finalidade, riscos e benefícios de referido tratamento, bem como dos efeitos colaterais e outras anormalidades e intercorrências que poderão advir do mesmo. Assim sendo, concordo em me submeter ao tratamento proposto e, para tanto, assino o presente documento na presença de duas testemunhas.';

    ensureSpace(150);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(DARK)
      .text(termo, 48, doc.y, {
        width: W,
        align: 'justify',
        lineGap: 3,
      });
    doc.moveDown(1.6);

    ensureSpace(96);
    doc.font('Helvetica').fontSize(10).fillColor(DARK).text(`Data: ${dados.dataConsulta || '-'}`, 48, doc.y, { width: W });
    doc.moveDown(2.4);

    const sigY = doc.y;
    const sigW = (W - 32) / 2;
    doc.moveTo(48, sigY).lineTo(48 + sigW, sigY).strokeColor(DARK).stroke();
    doc.moveTo(48 + sigW + 32, sigY).lineTo(48 + sigW + 32 + sigW, sigY).strokeColor(DARK).stroke();
    doc
      .fillColor(DARK)
      .font('Helvetica')
      .fontSize(9)
      .text('Assinatura do paciente/responsável', 48, sigY + 8, { width: sigW, align: 'center' })
      .text('Assinatura do fisioterapeuta', 48 + sigW + 32, sigY + 8, { width: sigW, align: 'center' });

    doc.end();
  });
}

function getNowInAppTimeZoneParts() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(new Date());
  const read = (type) => Number(parts.find((item) => item.type === type)?.value ?? '0');

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
    millisecond: 0,
  };
}

function getTokenExpirationParts(row) {
  if (!row) return null;

  const tokenGeradoEm = row.TokenGeradoEm ?? row.tokenGeradoEm ?? null;
  const tokenGeradoParts = extractSqlLocalDateTimeParts(tokenGeradoEm);
  if (!tokenGeradoParts) return null;

  const tokenExpiraParts = addMinutesToSqlLocalDateTime(tokenGeradoParts, TOKEN_EXPIRACAO_MIN);
  const checkinBase = row.CheckinHora ?? row.checkinHora ?? row.DataCheckin ?? row.dataCheckin ?? null;
  const checkinParts = extractSqlLocalDateTimeParts(checkinBase);
  if (!checkinParts) return tokenExpiraParts;

  const janelaOriginalParts = addMinutesToSqlLocalDateTime(checkinParts, TOKEN_EXPIRACAO_MIN);
  return localDateTimePartsToNaiveTimestamp(tokenExpiraParts) <= localDateTimePartsToNaiveTimestamp(janelaOriginalParts)
    ? tokenExpiraParts
    : janelaOriginalParts;
}

function parseJsonArraySafe(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Auto-confirmação (quando aplicável) após pagamento.
 *
 * Importante: quem "decide" se auto-confirma está habilitado é o backend,
 * com base no snapshot da consulta (Consultas.ConfirmacaoAutomatica).
 */
async function tentarAutoConfirmarConsultaAposPagamento(usuario, consultaId) {
  const info = await queryWithContext(usuario, (req) => {
    req.input('ConsultaId', sql.Int, Number(consultaId));
  }, `
    SELECT TOP 1
      c.Id,
      c.FisioterapeutaId,
      ISNULL(c.ConfirmacaoAutomatica, 0) AS ConfirmacaoAutomatica,
      LTRIM(RTRIM(ISNULL(c.Status, N''))) AS Status,
      LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))) AS StatusPagamento
    FROM dbo.Consultas c
    WHERE c.Id = @ConsultaId;
  `);

  const row = info.recordset?.[0];
  if (!row) return;

  const auto = row.ConfirmacaoAutomatica === true || row.ConfirmacaoAutomatica === 1;
  if (!auto) return;

  // SP_ConfirmarConsulta exige StatusPagamento = 'Pago'
  if (String(row.StatusPagamento || '') !== 'Pago') return;

  // Não tenta auto-confirmar em status finais, nem se já estiver confirmada
  const st = String(row.Status || '');
  if (st === STATUS.CONFIRMADA) return;
  if (isTerminalStatus(st)) return;

  try {
    await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, Number(consultaId));
      req.input('FisioterapeutaId', sql.Int, Number(row.FisioterapeutaId));
    }, `
      EXEC dbo.SP_ConfirmarConsulta
        @ConsultaId = @ConsultaId,
        @FisioterapeutaId = @FisioterapeutaId;
    `);
  } catch (err) {
    log('warn', '[autoConfirm] Falhou', { consultaId, erro: err?.message || err });
  }
}

async function validarConflitosAgendamento({
  usuario,
  pacienteId = null,
  fisioterapeutaId,
  dataHora,
  duracaoMinutos = DEFAULT_DURACAO_MIN,
  consultaIdIgnorar = null
}) {
  const rDisponibilidade = await queryWithContext(usuario, (req) => {
    req.input('FisioterapeutaId', sql.Int, Number(fisioterapeutaId));
    req.input('DataHora', sql.DateTime, dataHora);
    req.input('DuracaoMinutos', sql.Int, Number(duracaoMinutos));
    req.input('PacienteId', sql.Int, pacienteId ?? null);
    req.input('ConsultaIdIgnorar', sql.Int, consultaIdIgnorar ?? null);
  }, `
    EXEC dbo.SP_ValidarDisponibilidade
      @FisioterapeutaId  = @FisioterapeutaId,
      @DataHora          = @DataHora,
      @DuracaoMinutos    = @DuracaoMinutos,
      @PacienteId        = @PacienteId,
      @ConsultaIdIgnorar = @ConsultaIdIgnorar;
  `);

  const disponibilidade = rDisponibilidade?.recordset?.[0] ?? null;
  if (!disponibilidade?.Disponivel) {
    throw new HttpError(
      409,
      disponibilidade?.Mensagem ?? 'Horário indisponível.',
      {
        motivo: disponibilidade?.Motivo ?? null,
        conflitConsultaId: disponibilidade?.ConflitConsultaId ?? null,
      }
    );
  }
}

async function obterSumarioContratoPagamento(usuario) {
  try {
    const rDoc = await queryWithContext(usuario, (req) => {
      req.input('Tipo', sql.NVarChar(80), 'CancelamentoReembolso');
    }, `
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
        FROM dbo.vw_DocumentosLegais_Ativos d
        WHERE d.Tipo = @Tipo;
      END
    `);

    return rDoc?.recordset?.[0] ?? null;
  } catch {
    return null;
  }
}

async function selecionarPacoteDisponivelParaConsulta(
  { pacienteId, fisioterapeutaId, especialidadeId = null, pacoteId = null },
  usuario
) {
  const r = await queryWithContext(usuario, (req) => {
    req.input('PacienteId', sql.Int, pacienteId);
    req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    req.input('EspecialidadeId', sql.Int, especialidadeId);
    req.input('PacoteId', sql.Int, pacoteId);
  }, `
    SELECT TOP (1)
      p.Id
    FROM dbo.Pacotes p WITH (UPDLOCK, HOLDLOCK)
    WHERE p.PacienteId = @PacienteId
      AND p.FisioterapeutaId = @FisioterapeutaId
      AND (@PacoteId IS NULL OR p.Id = @PacoteId)
      AND LTRIM(RTRIM(ISNULL(p.Status, N''))) = N'Ativo'
      AND EXISTS (
        SELECT 1
        FROM dbo.CreditosPacientes cp WITH (READCOMMITTEDLOCK)
        WHERE cp.PacoteId = p.Id
          AND cp.PacienteId = @PacienteId
          AND LTRIM(RTRIM(ISNULL(cp.Status, N''))) = N'Disponivel'
          AND cp.UsadoEm IS NULL
          AND cp.ConsultaId IS NULL
      )
      AND (
        @EspecialidadeId IS NULL
        OR p.EspecialidadeId IS NULL
        OR p.EspecialidadeId = @EspecialidadeId
      )
    ORDER BY
      CASE WHEN @PacoteId IS NOT NULL THEN 0 ELSE 1 END,
      COALESCE(p.PagoEm, p.CriadoEm, p.DataCompra) ASC,
      p.Id ASC;
  `);

  return Number(r?.recordset?.[0]?.Id ?? 0) || null;
}

async function prepararDadosCriacaoConsulta(
  { PacienteId, FisioterapeutaId, DataHora, Observacoes = null, ValorConsulta = 0, DuracaoMinutos = null, EspecialidadeId = null },
  usuario
) {
  requireUser(usuario);

  if (!isAdmin(usuario) && !isPaciente(usuario)) {
    throw new HttpError(403, 'Somente Paciente (ou Admin) pode criar consulta.');
  }

  const pid = assertId(PacienteId, 'PacienteId');
  const fid = assertId(FisioterapeutaId, 'FisioterapeutaId');

  if (isPaciente(usuario) && Number(usuario.id) !== pid) {
    throw new HttpError(403, 'PacienteId deve ser o do usuário logado.');
  }

  const espId = EspecialidadeId != null && EspecialidadeId !== ''
    ? assertId(EspecialidadeId, 'EspecialidadeId')
    : null;

  ensureAgendamentoAPartirDeAmanha(DataHora, 'DataHora');
  const dataHora = parseLocalIsoToUtcNaive(DataHora, 'DataHora');
  const duracaoMin = parseNumber(DuracaoMinutos, 'DuracaoMinutos', { min: 15, max: 24 * 60 }) || DEFAULT_DURACAO_MIN;

  let valorFinal;
  let especialidadeIdFinal = null;

  if (espId != null) {
    const espRes = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fid);
      req.input('EspecialidadeId', sql.Int, espId);
    }, `
      SELECT vcf.ValorPacienteFinal
      FROM dbo.FisioterapeutaEspecialidades fe
      CROSS APPLY dbo.fn_ValorConsultaFinal(fe.ValorConsultaBase) vcf
      WHERE fe.FisioterapeutaId = @FisioterapeutaId
        AND fe.EspecialidadeId  = @EspecialidadeId
        AND fe.ValorConsultaBase IS NOT NULL;
    `);

    if (!espRes.recordset?.length) {
      throw new HttpError(400, 'Especialidade não encontrada ou sem preço configurado para este fisioterapeuta.');
    }
    valorFinal = Number(espRes.recordset[0].ValorPacienteFinal);
    especialidadeIdFinal = espId;
  } else {
    const valRes = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fid);
    }, `
      SELECT ValorConsulta
      FROM dbo.vw_FisioterapeutaPerfilPublico
      WHERE FisioterapeutaId = @FisioterapeutaId;
    `);

    if (!valRes.recordset?.length) {
      throw new HttpError(404, 'Fisioterapeuta não encontrado (perfil público).');
    }
    valorFinal = Number(valRes.recordset[0].ValorConsulta);
  }

  const valorPayload = ValorConsulta == null ? null : Number(ValorConsulta);
  if (valorPayload != null && (!Number.isFinite(valorPayload) || valorPayload < 0)) {
    throw new HttpError(400, 'ValorConsulta inválido.');
  }

  if (!Number.isFinite(valorFinal) || valorFinal <= 0) {
    throw new HttpError(400, 'ValorConsulta inválido para este fisioterapeuta.');
  }

  valorFinal = Math.round(valorFinal * 100) / 100;

  const obs = normalizeText(Observacoes, 510);

  const paciente = await queryWithContext(usuario, (req) => {
    req.input('PacienteId', sql.Int, pid);
  }, `SELECT Estado FROM dbo.Pacientes WHERE Id = @PacienteId;`);

  const fisio = await queryWithContext(usuario, (req) => {
    req.input('FisioterapeutaId', sql.Int, fid);
  }, `SELECT Estado, CREFITO, CrefitoVerificado FROM dbo.Fisioterapeutas WHERE Id = @FisioterapeutaId;`);

  if (!paciente.recordset?.length || !fisio.recordset?.length) {
    throw new HttpError(404, 'Paciente ou Fisioterapeuta não encontrado.');
  }

  const estadoPaciente = paciente.recordset[0].Estado;
  const estadoFisio = fisio.recordset[0].Estado;
  const crefito = fisio.recordset[0].CREFITO;
  const crefitoVerificado = fisio.recordset[0].CrefitoVerificado;

  if (!crefitoVerificado) {
    throw new HttpError(403, 'Este fisioterapeuta ainda não pode atender: CREFITO pendente de verificação.');
  }

  if (estadoPaciente !== estadoFisio) {
    throw new HttpError(403, 'Atendimento não permitido (jurisdição diferente).', {
      crefito,
      estadoPaciente,
      estadoFisio
    });
  }

  await validarConflitosAgendamento({
    usuario,
    pacienteId: pid,
    fisioterapeutaId: fid,
    dataHora,
    duracaoMinutos: duracaoMin
  });

  return {
    pacienteId: pid,
    fisioterapeutaId: fid,
    dataHora,
    observacoes: obs,
    valorFinal,
    duracaoMin,
    origemAgendamento: 'PacienteApp',
    especialidadeId: especialidadeIdFinal
  };
}

const consultasService = {
  /**
   * ADMIN: listar todas (sem dbo.vw_ConsultasStatus)
   */
  async listarTodas(usuario) {
    if (!isAdmin(usuario)) {
      throw new HttpError(403, 'Acesso negado. Somente administrador pode listar todas as consultas.');
    }

    const result = await queryWithContext(usuario, null, `
      SELECT
        c.*,
        p.Nome AS PacienteNome,
        p.EnderecoComercial AS PacienteEnderecoComercial,
        p.EnderecoResidencial AS PacienteEnderecoResidencial,
        p.BairroComercial AS PacienteBairroComercial,
        p.BairroResidencial AS PacienteBairroResidencial,
        p.Cep AS PacienteCep,
        p.Cidade AS PacienteCidade,
        p.Estado AS PacienteEstado,
        f.Nome AS NomeFisioterapeuta
      FROM dbo.Consultas c
      LEFT JOIN dbo.Pacientes p ON p.Id = c.PacienteId
      LEFT JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
      ORDER BY c.DataHora DESC;
    `);

    return result.recordset || [];
  },

  /**
   * FISIO: pendentes/confirmadas usando analytics.vw_FisioAtendimentosPendentes
   * Observação: a view NÃO tem Id. Para o app conseguir abrir /consultas/:id,
   * fazemos um "match" para trazer ConsultaId via OUTER APPLY em dbo.Consultas.
   */
  async listarPendentesConfirmadasPorFisio(usuario, opts = {}) {
    requireUser(usuario);
    if (!isAdmin(usuario) && !isFisio(usuario)) throw new HttpError(403, 'Acesso negado.');

    const fid = isAdmin(usuario)
      ? assertId(opts?.fisioterapeutaId ?? usuario.id, 'FisioterapeutaId')
      : assertId(usuario.id, 'Usuário');

    const somentePago = isFisio(usuario) ? 1 : Number(opts?.somentePago ?? 0);

    const result = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fid);
      req.input('SomentePago', sql.Bit, !!somentePago);
    }, `
      IF OBJECT_ID('analytics.vw_FisioAtendimentosPendentes', 'V') IS NULL
      BEGIN
        THROW 50020, 'View analytics.vw_FisioAtendimentosPendentes não encontrada.', 1;
      END

      SELECT
        v.ConsultaId,
        c.PacienteId,
        v.FisioterapeutaId,
        v.NomeFisioterapeuta,
        v.PacienteNome,
        p.CPFValido AS PacienteCPFValido,
        p.EmailVerificado AS PacienteEmailVerificado,
        p.TelefoneVerificado AS PacienteTelefoneVerificado,
        CAST(CASE
          WHEN ISNULL(p.CPFValido, 0) = 1
           AND ISNULL(p.EmailVerificado, 0) = 1
           AND ISNULL(p.TelefoneVerificado, 0) = 1
            THEN 1 ELSE 0
        END AS bit) AS PacienteContaVerificada,
        p.EnderecoComercial AS PacienteEnderecoComercial,
        p.EnderecoResidencial AS PacienteEnderecoResidencial,
        p.BairroComercial AS PacienteBairroComercial,
        p.BairroResidencial AS PacienteBairroResidencial,
        p.Cep AS PacienteCep,
        p.Cidade AS PacienteCidade,
        p.Estado AS PacienteEstado,
        v.DataHora,
        v.Status,
        v.ValorConsulta,
        c.StatusPagamento,
        ISNULL(c.PagamentoViaPlataforma, 1) AS PagamentoViaPlataforma,
        c.ChatLiberado,
        c.ChatLiberadoEm,
        c.CheckinHora,
        c.DataCheckin,
        COALESCE(v.TokenValidacao, c.TokenValidacao) AS TokenValidacao,
        av.AvaliacoesPacienteJson,
        avs.AvaliacoesPacienteTotal,
        avs.AvaliacoesPacienteNotaMedia,
        v.StatusOrdem
      FROM analytics.vw_FisioAtendimentosPendentes v
      INNER JOIN dbo.Consultas c
        ON c.Id = v.ConsultaId
      LEFT JOIN dbo.Pacientes p
        ON p.Id = c.PacienteId
      OUTER APPLY (
        SELECT TOP (5)
          a.Id,
          a.FisioterapeutaId,
          f2.Nome AS FisioterapeutaNome,
          a.Nota,
          a.Comentario,
          a.DataAvaliacao
        FROM dbo.Avaliacoes a
        LEFT JOIN dbo.Fisioterapeutas f2
          ON f2.Id = a.FisioterapeutaId
        WHERE a.PacienteId = c.PacienteId
        ORDER BY a.DataAvaliacao DESC, a.Id DESC
        FOR JSON PATH
      ) av (AvaliacoesPacienteJson)

      OUTER APPLY (
        SELECT
          COUNT(1) AS AvaliacoesPacienteTotal,
          CAST(AVG(CAST(a2.Nota AS float)) AS decimal(5,2)) AS AvaliacoesPacienteNotaMedia
        FROM dbo.Avaliacoes a2
        WHERE a2.PacienteId = c.PacienteId
          AND a2.Nota IS NOT NULL
      ) avs

      WHERE v.FisioterapeutaId = @FisioterapeutaId
        AND (
          @SomentePago = 0 OR
          UPPER(LTRIM(RTRIM(ISNULL(c.StatusPagamento, N'')))) COLLATE Latin1_General_CI_AI
            IN (N'PAGO', N'CREDITOPACIENTE')
        )
        AND (
          UPPER(LTRIM(RTRIM(ISNULL(v.Status, N'')))) COLLATE Latin1_General_CI_AI
          IN (N'AGUARDANDO', N'AGUARDANDOCONFIRMACAO', N'AGENDADA', N'PENDENTE', N'CONFIRMADA')
        )
      ORDER BY v.StatusOrdem ASC, v.DataHora ASC, v.ConsultaId DESC;
    `);

  return (result.recordset || []).map((r) => {
    const base = {
      ConsultaId: Number(r.ConsultaId || 0),
      PacienteId: r.PacienteId ?? null,
      FisioterapeutaId: r.FisioterapeutaId,
      NomeFisioterapeuta: r.NomeFisioterapeuta,
      PacienteNome: r.PacienteNome,
      PacienteCPFValido: r.PacienteCPFValido ?? null,
      PacienteEmailVerificado: r.PacienteEmailVerificado ?? null,
      PacienteTelefoneVerificado: r.PacienteTelefoneVerificado ?? null,
      PacienteContaVerificada: r.PacienteContaVerificada ?? null,
      DataHora: formatSqlLocalDateTime(r.DataHora),
      Status: r.Status,
      ValorConsulta: r.ValorConsulta,
      StatusPagamento: r.StatusPagamento ?? null,
      PagamentoViaPlataforma: r.PagamentoViaPlataforma === true || r.PagamentoViaPlataforma === 1 ? true : false,
      ChatLiberado: r.ChatLiberado ?? null,
      ChatLiberadoEm: formatSqlLocalDateTime(r.ChatLiberadoEm),
      CheckinHora: formatSqlLocalDateTime(r.CheckinHora),
      DataCheckin: formatSqlLocalDateTime(r.DataCheckin),
      TokenValidacao: r.TokenValidacao ?? null,

      // Avaliações públicas do paciente (para ajudar o fisio a identificar histórico de problemas)
      AvaliacoesPaciente: parseJsonArraySafe(r.AvaliacoesPacienteJson),
      AvaliacoesPacienteResumo: {
        Total: Number(r.AvaliacoesPacienteTotal ?? 0),
        NotaMedia: r.AvaliacoesPacienteNotaMedia != null ? Number(r.AvaliacoesPacienteNotaMedia) : null
      },

      // Endereços do paciente (para deslocamento do fisioterapeuta)
      PacienteEnderecoResidencial: r.PacienteEnderecoResidencial ?? null,
      PacienteEnderecoComercial: r.PacienteEnderecoComercial ?? null,
      PacienteBairroResidencial: r.PacienteBairroResidencial ?? null,
      PacienteBairroComercial: r.PacienteBairroComercial ?? null,
      PacienteCep: r.PacienteCep ?? null,
      PacienteCidade: r.PacienteCidade ?? null,
      PacienteEstado: r.PacienteEstado ?? null
    };

    return enrichConsultaComEnderecos(base);
  });
},


  /**
   * Lista “minhas”:
   * - Fisio: pendentes/confirmadas via analytics.vw_FisioAtendimentosPendentes
   * - Paciente: todas do paciente via dbo.Consultas
   */
  async listarMinhas(usuario, opcoes = {}) {
    requireUser(usuario);

    if (isAdmin(usuario)) {
      throw new HttpError(400, 'Admin deve usar filtros (listarTodas/listarPorPaciente/listarPorFisio).');
    }

    const tipo = String(opcoes?.tipo || '').toLowerCase();

    // FISIOTERAPEUTA: mantém o “listar” atual (pendentes/confirmadas) e adiciona histórico
    if (isFisio(usuario)) {
      if (tipo === 'historico' || tipo === 'histórico') {
        const statusList = ['Concluída', 'Cancelada', 'Paciente Ausente', 'Fisioterapeuta Ausente'];
        const rows = await this.listarPorFisio(usuario.id, usuario, { statusList });
        return (rows || []).map((r) => ({
          ...formatConsultaPacienteList(r),
          PagamentoViaPlataforma: r.PagamentoViaPlataforma === true || r.PagamentoViaPlataforma === 1 ? true : false,
        }));
      }

      // padrão (já existente): pendentes/confirmadas
      return await this.listarPendentesConfirmadasPorFisio(usuario);
    }

    // PACIENTE
    if (isPaciente(usuario)) {
      // Ativas = Aguardando/Confirmada (padrão); Histórico = Concluída/Cancelada/Paciente Ausente/Fisioterapeuta Ausente
      const statusList = (tipo === 'historico' || tipo === 'histórico')
        ? ['Concluída', 'Cancelada', 'Paciente Ausente', 'Fisioterapeuta Ausente']
        : ['Aguardando', 'Confirmada'];

      const rows = await this.listarPorPaciente(usuario.id, usuario, { statusList });
      return (rows || []).map(formatConsultaPacienteList);
    }

    throw new HttpError(403, 'Tipo de usuário não suportado.');
  },

  /**
   * Busca por ID respeitando permissões (sem dbo.vw_ConsultasStatus):
   * - Admin: qualquer
   * - Fisio: somente dele
   * - Paciente: somente dele
   */
  async buscarPorId(id, usuario) {
    const consultaId = assertId(id, 'Id de consulta');

    if (isAdmin(usuario)) {
      const r = await queryWithContext(usuario, (req) => {
        req.input('Id', sql.Int, consultaId);
      }, `
        SELECT TOP 1
          c.*,
          p.Nome AS PacienteNome,
          p.CPFValido AS PacienteCPFValido,
          p.EmailVerificado AS PacienteEmailVerificado,
          p.TelefoneVerificado AS PacienteTelefoneVerificado,
          CAST(CASE
            WHEN ISNULL(p.CPFValido, 0) = 1
             AND ISNULL(p.EmailVerificado, 0) = 1
             AND ISNULL(p.TelefoneVerificado, 0) = 1
              THEN 1 ELSE 0
          END AS bit) AS PacienteContaVerificada,
          p.EnderecoComercial AS PacienteEnderecoComercial,
          p.ComplementoComercial AS PacienteComplementoComercial,
          p.BairroComercial AS PacienteBairroComercial,
          p.EnderecoResidencial AS PacienteEnderecoResidencial,
          p.ComplementoResidencial AS PacienteComplementoResidencial,
          p.BairroResidencial AS PacienteBairroResidencial,
          p.Cep AS PacienteCep,
          p.Cidade AS PacienteCidade,
          p.Estado AS PacienteEstado,
          f.Nome AS NomeFisioterapeuta,
          ISNULL(e.Nome, f.Especialidade) AS EspecialidadeFisioterapeuta,
          f.ToleranciaCancelamentoMinutos AS ToleranciaCancelamentoMinutos,
          av.AvaliacoesPacienteJson,
          avs.AvaliacoesPacienteTotal,
          avs.AvaliacoesPacienteNotaMedia
        FROM dbo.Consultas c
        LEFT JOIN dbo.Pacientes p ON p.Id = c.PacienteId
        LEFT JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
        LEFT JOIN dbo.Especialidades e ON e.Id = c.EspecialidadeId
        OUTER APPLY (
          SELECT TOP (5)
            a.Id,
            a.FisioterapeutaId,
            f2.Nome AS FisioterapeutaNome,
            a.Nota,
            a.Comentario,
            a.DataAvaliacao
          FROM dbo.Avaliacoes a
          LEFT JOIN dbo.Fisioterapeutas f2 ON f2.Id = a.FisioterapeutaId
          WHERE a.PacienteId = c.PacienteId
          ORDER BY a.DataAvaliacao DESC, a.Id DESC
          FOR JSON PATH
        ) av (AvaliacoesPacienteJson)
        OUTER APPLY (
          SELECT
            COUNT(1) AS AvaliacoesPacienteTotal,
            CAST(AVG(CAST(a2.Nota AS float)) AS decimal(5,2)) AS AvaliacoesPacienteNotaMedia
          FROM dbo.Avaliacoes a2
          WHERE a2.PacienteId = c.PacienteId
            AND a2.Nota IS NOT NULL
        ) avs
        WHERE c.Id = @Id;
      `);

      return enrichConsultaComEnderecos(r.recordset?.[0] || null);
    }

    requireUser(usuario);

    const usuarioId = Number(usuario.id);
    const ehFisio = isFisio(usuario) ? 1 : 0;
    const ehPaciente = isPaciente(usuario) ? 1 : 0;

    const r = await queryWithContext(usuario, (req) => {
      req.input('Id', sql.Int, consultaId);
      req.input('UsuarioId', sql.Int, usuarioId);
      req.input('EhFisio', sql.Bit, ehFisio);
      req.input('EhPaciente', sql.Bit, ehPaciente);
    }, `
      SELECT TOP 1
        c.*,
        p.Nome AS PacienteNome,
        p.CPFValido AS PacienteCPFValido,
        p.EmailVerificado AS PacienteEmailVerificado,
        p.TelefoneVerificado AS PacienteTelefoneVerificado,
        CAST(CASE
          WHEN ISNULL(p.CPFValido, 0) = 1
           AND ISNULL(p.EmailVerificado, 0) = 1
           AND ISNULL(p.TelefoneVerificado, 0) = 1
            THEN 1 ELSE 0
        END AS bit) AS PacienteContaVerificada,
        p.EnderecoComercial AS PacienteEnderecoComercial,
        p.ComplementoComercial AS PacienteComplementoComercial,
        p.BairroComercial AS PacienteBairroComercial,
        p.EnderecoResidencial AS PacienteEnderecoResidencial,
        p.ComplementoResidencial AS PacienteComplementoResidencial,
        p.BairroResidencial AS PacienteBairroResidencial,
        p.Cep AS PacienteCep,
        p.Cidade AS PacienteCidade,
        p.Estado AS PacienteEstado,
        f.Nome AS NomeFisioterapeuta,
        ISNULL(e.Nome, f.Especialidade) AS EspecialidadeFisioterapeuta,
        f.ToleranciaCancelamentoMinutos AS ToleranciaCancelamentoMinutos,
        CASE
          WHEN @EhPaciente = 1 AND EXISTS (
            SELECT 1
            FROM dbo.Denuncias d
            WHERE d.ConsultaId = c.Id
              AND d.DenuncianteTipo = N'Paciente'
              AND d.DenuncianteId = @UsuarioId
              AND d.DenunciadoTipo = N'Fisioterapeuta'
              AND d.DenunciadoId = c.FisioterapeutaId
          ) THEN CAST(1 AS bit)
          WHEN @EhFisio = 1 AND EXISTS (
            SELECT 1
            FROM dbo.Denuncias d
            WHERE d.ConsultaId = c.Id
              AND d.DenuncianteTipo = N'Fisioterapeuta'
              AND d.DenuncianteId = @UsuarioId
              AND d.DenunciadoTipo = N'Paciente'
              AND d.DenunciadoId = c.PacienteId
          ) THEN CAST(1 AS bit)
          ELSE CAST(0 AS bit)
        END AS DenunciaJaRegistrada,
        CASE
          WHEN @EhPaciente = 1 AND EXISTS (
            SELECT 1
            FROM dbo.Transacoes t
            WHERE t.ConsultaId = c.Id
              AND t.PacienteId = @UsuarioId
              AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago'
          ) THEN CAST(1 AS bit)
          ELSE CAST(0 AS bit)
        END AS TemTransacaoPaga,
        (
          SELECT TOP (1) LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N'')))
          FROM dbo.Transacoes t
          WHERE t.ConsultaId = c.Id
            AND t.PacienteId = @UsuarioId
            AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago'
          ORDER BY t.Id DESC
        ) AS MetodoPagamentoTransacao,
        CASE
          WHEN @EhPaciente = 1 AND (
            EXISTS (
              SELECT 1
              FROM dbo.CreditosPacientes cp
              WHERE cp.ConsultaId = c.Id
                AND cp.PacienteId = @UsuarioId
                AND cp.PacoteId IS NOT NULL
            )
            OR EXISTS (
              SELECT 1
              FROM dbo.Transacoes t
              WHERE t.ConsultaId = c.Id
                AND t.PacienteId = @UsuarioId
                AND LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N''))) = N'Pacote'
            )
          ) THEN CAST(1 AS bit)
          ELSE CAST(0 AS bit)
        END AS PagoComPacote,
        ISNULL(va.TentativasInvalidas, 0) AS TentativasInvalidasToken,
        CASE WHEN ISNULL(va.MaxTentativas, 0) <= 0 THEN 3 ELSE va.MaxTentativas END AS MaxTentativasToken,
        CASE
          WHEN ISNULL(va.TentativasInvalidas, 0) >= CASE WHEN ISNULL(va.MaxTentativas, 0) <= 0 THEN 3 ELSE va.MaxTentativas END
          THEN CAST(1 AS bit)
          ELSE CAST(0 AS bit)
        END AS LimiteTentativasTokenAtingido,
        av.AvaliacoesPacienteJson,
        avs.AvaliacoesPacienteTotal,
        avs.AvaliacoesPacienteNotaMedia
      FROM dbo.Consultas c
      LEFT JOIN dbo.Pacientes p ON p.Id = c.PacienteId
      LEFT JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
      LEFT JOIN dbo.Especialidades e ON e.Id = c.EspecialidadeId
      OUTER APPLY (
        SELECT TOP 1
          va.TentativasInvalidas,
          va.MaxTentativas
        FROM dbo.ValidacoesAtendimento va
        WHERE va.ConsultaId = c.Id
        ORDER BY va.Id DESC
      ) va
      OUTER APPLY (
        SELECT TOP (5)
          a.Id,
          a.FisioterapeutaId,
          f2.Nome AS FisioterapeutaNome,
          f2.CREFITO AS FisioterapeutaCrefito,
          a.Nota,
          a.Comentario,
          a.DataAvaliacao
        FROM dbo.Avaliacoes a
        LEFT JOIN dbo.Fisioterapeutas f2 ON f2.Id = a.FisioterapeutaId
        WHERE a.PacienteId = c.PacienteId
        ORDER BY a.DataAvaliacao DESC, a.Id DESC
        FOR JSON PATH
      ) av (AvaliacoesPacienteJson)
      OUTER APPLY (
        SELECT
          COUNT(1) AS AvaliacoesPacienteTotal,
          CAST(AVG(CAST(a2.Nota AS float)) AS decimal(5,2)) AS AvaliacoesPacienteNotaMedia
        FROM dbo.Avaliacoes a2
        WHERE a2.PacienteId = c.PacienteId
          AND a2.Nota IS NOT NULL
      ) avs
      WHERE c.Id = @Id
        AND (
          (@EhFisio = 1 AND c.FisioterapeutaId = @UsuarioId)
          OR
          (@EhPaciente = 1 AND c.PacienteId = @UsuarioId)
        );
    `);

    const row = r.recordset?.[0] || null;

    if (isPaciente(usuario)) {
      // Paciente: resposta reduzida (sem endereço/rotas, sem campos internos)
      const detalhe = formatConsultaPacienteDetalhe(row);
      if (!detalhe) return detalhe;

      const pendenciaAvaliacao =
        row?.PacienteId && row?.FisioterapeutaId
          ? await obterPendenciaAvaliacaoFisioterapeuta(
              usuario,
              row.PacienteId,
              row.FisioterapeutaId
            )
          : {
              PodeAvaliarFisioterapeuta: false,
              ConsultaPendenteAvaliacaoId: null,
            };

      return {
        ...detalhe,
        PodeAvaliarFisioterapeuta:
          Boolean(pendenciaAvaliacao?.PodeAvaliarFisioterapeuta) &&
          Number(pendenciaAvaliacao?.ConsultaPendenteAvaliacaoId ?? 0) === Number(row?.Id ?? 0),
        ConsultaPendenteAvaliacaoId: pendenciaAvaliacao?.ConsultaPendenteAvaliacaoId ?? null,
      };
    }

    const detalheFisio = formatConsultaFisioDetalhe(enrichConsultaComEnderecos(row));
    if (!detalheFisio) return detalheFisio;

    const pendenciaAvaliacaoPaciente =
      row?.PacienteId && row?.FisioterapeutaId
        ? await obterPendenciaAvaliacaoPaciente(
            usuario,
            row.PacienteId,
            row.FisioterapeutaId
          )
        : {
            PodeAvaliarPaciente: false,
            ConsultaPendenteAvaliacaoPacienteId: null,
          };

    return {
      ...detalheFisio,
      PodeAvaliarPaciente:
        Boolean(pendenciaAvaliacaoPaciente?.PodeAvaliarPaciente) &&
        Number(pendenciaAvaliacaoPaciente?.ConsultaPendenteAvaliacaoPacienteId ?? 0) === Number(row?.Id ?? 0),
      ConsultaPendenteAvaliacaoPacienteId:
        pendenciaAvaliacaoPaciente?.ConsultaPendenteAvaliacaoPacienteId ?? null,
    };
  },

  async gerarTermoConsentimentoPdf(id, usuario) {
    const consultaId = assertId(id, 'Id de consulta');
    requireUser(usuario);

    if (!isAdmin(usuario) && !isFisio(usuario)) {
      throw new HttpError(403, 'Apenas o fisioterapeuta da consulta ou um admin pode baixar o termo.');
    }

    const r = await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, consultaId);
    }, `
      SELECT TOP 1
        c.Id,
        c.DataHora,
        c.Status,
        c.FisioterapeutaId,
        p.Nome AS PacienteNome,
        p.DataNascimento,
        f.Nome AS FisioNome,
        f.CREFITO,
        f.Estado AS FisioEstado,
        ISNULL(e.Nome, f.Especialidade) AS EspecialidadeNome
      FROM dbo.Consultas c
      INNER JOIN dbo.Pacientes p ON p.Id = c.PacienteId
      INNER JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
      LEFT JOIN dbo.Especialidades e ON e.Id = c.EspecialidadeId
      WHERE c.Id = @ConsultaId;
    `);

    const row = r.recordset?.[0] || null;
    if (!row) throw new HttpError(404, 'Consulta não encontrada.');

    if (isFisio(usuario) && Number(row.FisioterapeutaId) !== Number(usuario.id)) {
      throw new HttpError(403, 'Acesso negado ao termo desta consulta.');
    }

    const status = String(row.Status || '').trim();
    const statusPermitidos = new Set([
      STATUS.CONFIRMADA,
      STATUS.CONCLUIDA,
      STATUS.PACIENTE_AUSENTE,
      STATUS.FISIOTERAPEUTA_AUSENTE,
    ]);

    if (!statusPermitidos.has(status)) {
      throw new HttpError(409, 'Termo de consentimento disponível somente após a confirmação da consulta.');
    }

    const fisioCrefito = formatarCrefitoNumeroTermo(row.CREFITO, row.FisioEstado);
    const dataConsulta = formatSqlDateBR(row.DataHora);
    const dataNascimento = formatSqlDateBR(row.DataNascimento);
    const idade = calcularIdadeNaData(row.DataNascimento, row.DataHora);

    const buffer = await gerarTermoConsentimentoPdfBuffer({
      consultaId,
      pacienteNome: normalizeText(row.PacienteNome, 300) || '-',
      dataNascimento,
      idade,
      fisioNome: normalizeText(row.FisioNome, 300) || '-',
      fisioCrefito,
      dataConsulta,
      procedimentoFisioterapeutico: normalizeText(row.EspecialidadeNome, 200) || '-',
    });

    const pacienteSafe = safeFilenamePart(row.PacienteNome, 'paciente');

    return {
      buffer,
      filename: `termo-consentimento-consulta-${consultaId}-${pacienteSafe}.pdf`,
    };
  },

  /**
   * Lista por fisioterapeuta:
   * - Admin: usa parâmetro
   * - Fisio: SEMPRE usa o próprio id
   */
  
  async listarPorFisio(fisioterapeutaId, usuario, opcoes = {}) {
    const statusList = Array.isArray(opcoes?.statusList) ? opcoes.statusList.filter(Boolean) : [];
    const statusParams = statusList.map((_, i) => `@Status${i}`).join(', ');
    const statusFilterSql = statusList.length ? ` AND c.Status IN (${statusParams})` : '';
    
    if (isAdmin(usuario)) {
      const fid = assertId(fisioterapeutaId, 'FisioterapeutaId');

      const r = await queryWithContext(usuario, (req) => {
        req.input('FisioterapeutaId', sql.Int, fid);
        if (statusList.length) {
          statusList.forEach((s, i) => req.input(`Status${i}`, sql.NVarChar(60), s));
        }
      }, `
        SELECT
          c.*,
          p.Nome AS PacienteNome,
          p.CPFValido AS PacienteCPFValido,
          p.EmailVerificado AS PacienteEmailVerificado,
          p.TelefoneVerificado AS PacienteTelefoneVerificado,
          CAST(CASE
            WHEN ISNULL(p.CPFValido, 0) = 1
             AND ISNULL(p.EmailVerificado, 0) = 1
             AND ISNULL(p.TelefoneVerificado, 0) = 1
              THEN 1 ELSE 0
          END AS bit) AS PacienteContaVerificada,
          p.EnderecoComercial AS PacienteEnderecoComercial,
          p.EnderecoResidencial AS PacienteEnderecoResidencial,
          p.BairroComercial AS PacienteBairroComercial,
          p.BairroResidencial AS PacienteBairroResidencial,
          p.Cep AS PacienteCep,
          p.Cidade AS PacienteCidade,
          p.Estado AS PacienteEstado,
          f.Nome AS NomeFisioterapeuta,
          ISNULL(e.Nome, f.Especialidade) AS EspecialidadeFisioterapeuta
        FROM dbo.Consultas c
        LEFT JOIN dbo.Pacientes p ON p.Id = c.PacienteId
        LEFT JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
        LEFT JOIN dbo.Especialidades e ON e.Id = c.EspecialidadeId
        WHERE c.FisioterapeutaId = @FisioterapeutaId
        ${statusFilterSql}
        ORDER BY c.DataHora DESC;
      `);

      return r.recordset || [];
    }

    if (!isFisio(usuario) || !usuario?.id) throw new HttpError(403, 'Acesso negado.');

    const r = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, Number(usuario.id));
      if (statusList.length) {
        statusList.forEach((s, i) => req.input(`Status${i}`, sql.NVarChar(60), s));
      }
    }, `
      SELECT
        c.*,
        p.Nome AS PacienteNome,
        p.CPFValido AS PacienteCPFValido,
        p.EmailVerificado AS PacienteEmailVerificado,
        p.TelefoneVerificado AS PacienteTelefoneVerificado,
        CAST(CASE
          WHEN ISNULL(p.CPFValido, 0) = 1
           AND ISNULL(p.EmailVerificado, 0) = 1
           AND ISNULL(p.TelefoneVerificado, 0) = 1
            THEN 1 ELSE 0
        END AS bit) AS PacienteContaVerificada,
        p.EnderecoComercial AS PacienteEnderecoComercial,
        p.EnderecoResidencial AS PacienteEnderecoResidencial,
        p.BairroComercial AS PacienteBairroComercial,
        p.BairroResidencial AS PacienteBairroResidencial,
        p.Cep AS PacienteCep,
        p.Cidade AS PacienteCidade,
        p.Estado AS PacienteEstado,
        f.Nome AS NomeFisioterapeuta,
        ISNULL(e.Nome, f.Especialidade) AS EspecialidadeFisioterapeuta
      FROM dbo.Consultas c
      LEFT JOIN dbo.Pacientes p ON p.Id = c.PacienteId
      LEFT JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
      LEFT JOIN dbo.Especialidades e ON e.Id = c.EspecialidadeId
      WHERE c.FisioterapeutaId = @FisioterapeutaId
      ${statusFilterSql}
      ORDER BY c.DataHora DESC;
    `);

    return r.recordset || [];
  },

  /**
   * Lista por paciente:
   * - Admin: usa parâmetro
   * - Paciente: SEMPRE usa o próprio id
   */
  async listarPorPaciente(pacienteId, usuario, opcoes = {}) {
    const statusList = Array.isArray(opcoes?.statusList) ? opcoes.statusList.filter(Boolean) : null;
    const statusParams = statusList?.map((_, i) => `@Status${i}`).join(', ');
    const statusWhere = statusList?.length ? ` AND c.Status IN (${statusParams})` : '';

    if (isAdmin(usuario)) {
      const pid = assertId(pacienteId, 'PacienteId');

      const r = await queryWithContext(usuario, (req) => {
        req.input('PacienteId', sql.Int, pid);
        if (statusList?.length) {
          statusList.forEach((s, i) => req.input(`Status${i}`, sql.NVarChar(60), s));
        }
      }, `
        SELECT
          c.*,
          p.Nome AS PacienteNome,
          p.CPFValido AS PacienteCPFValido,
          p.EmailVerificado AS PacienteEmailVerificado,
          p.TelefoneVerificado AS PacienteTelefoneVerificado,
          CAST(CASE
            WHEN ISNULL(p.CPFValido, 0) = 1
             AND ISNULL(p.EmailVerificado, 0) = 1
             AND ISNULL(p.TelefoneVerificado, 0) = 1
              THEN 1 ELSE 0
          END AS bit) AS PacienteContaVerificada,
          p.EnderecoComercial AS PacienteEnderecoComercial,
          p.EnderecoResidencial AS PacienteEnderecoResidencial,
          p.BairroComercial AS PacienteBairroComercial,
          p.BairroResidencial AS PacienteBairroResidencial,
          p.Cep AS PacienteCep,
          p.Cidade AS PacienteCidade,
          p.Estado AS PacienteEstado,
          f.Nome AS NomeFisioterapeuta,
          CAST(CASE
            WHEN EXISTS (
              SELECT 1
              FROM dbo.Transacoes t
              WHERE t.ConsultaId = c.Id
                AND t.PacienteId = @PacienteId
                AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago'
            ) THEN 1 ELSE 0
          END AS bit) AS TemTransacaoPaga,
          (
            SELECT TOP (1) LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N'')))
            FROM dbo.Transacoes t
            WHERE t.ConsultaId = c.Id
              AND t.PacienteId = @PacienteId
              AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago'
            ORDER BY t.Id DESC
          ) AS MetodoPagamentoTransacao,
          CAST(CASE
            WHEN (
              EXISTS (
                SELECT 1
                FROM dbo.CreditosPacientes cp
                WHERE cp.ConsultaId = c.Id
                  AND cp.PacienteId = @PacienteId
                  AND cp.PacoteId IS NOT NULL
              )
              OR EXISTS (
                SELECT 1
                FROM dbo.Transacoes t
                WHERE t.ConsultaId = c.Id
                  AND t.PacienteId = @PacienteId
                  AND LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N''))) = N'Pacote'
              )
            ) THEN 1 ELSE 0
          END AS bit) AS PagoComPacote
        FROM dbo.Consultas c
        LEFT JOIN dbo.Pacientes p ON p.Id = c.PacienteId
        LEFT JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
        WHERE c.PacienteId = @PacienteId${statusWhere}
        ORDER BY c.DataHora DESC;
      `);

      return r.recordset || [];
    }

    if (!isPaciente(usuario) || !usuario?.id) throw new HttpError(403, 'Acesso negado.');

    const r = await queryWithContext(usuario, (req) => {
      req.input('PacienteId', sql.Int, Number(usuario.id));
      if (statusList?.length) {
        statusList.forEach((s, i) => req.input(`Status${i}`, sql.NVarChar(60), s));
      }
    }, `
      SELECT
        c.*,
        p.Nome AS PacienteNome,
        p.CPFValido AS PacienteCPFValido,
        p.EmailVerificado AS PacienteEmailVerificado,
        p.TelefoneVerificado AS PacienteTelefoneVerificado,
        CAST(CASE
          WHEN ISNULL(p.CPFValido, 0) = 1
           AND ISNULL(p.EmailVerificado, 0) = 1
           AND ISNULL(p.TelefoneVerificado, 0) = 1
            THEN 1 ELSE 0
        END AS bit) AS PacienteContaVerificada,
        f.Nome AS NomeFisioterapeuta,
        ISNULL(e.Nome, f.Especialidade) AS EspecialidadeFisioterapeuta,
        CAST(CASE
          WHEN EXISTS (
            SELECT 1
            FROM dbo.Transacoes t
            WHERE t.ConsultaId = c.Id
              AND t.PacienteId = @PacienteId
              AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago'
          ) THEN 1 ELSE 0
        END AS bit) AS TemTransacaoPaga,
        (
          SELECT TOP (1) LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N'')))
          FROM dbo.Transacoes t
          WHERE t.ConsultaId = c.Id
            AND t.PacienteId = @PacienteId
            AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago'
          ORDER BY t.Id DESC
        ) AS MetodoPagamentoTransacao,
        CAST(CASE
          WHEN (
            EXISTS (
              SELECT 1
              FROM dbo.CreditosPacientes cp
              WHERE cp.ConsultaId = c.Id
                AND cp.PacienteId = @PacienteId
                AND cp.PacoteId IS NOT NULL
            )
            OR EXISTS (
              SELECT 1
              FROM dbo.Transacoes t
              WHERE t.ConsultaId = c.Id
                AND t.PacienteId = @PacienteId
                AND LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N''))) = N'Pacote'
            )
          ) THEN 1 ELSE 0
        END AS bit) AS PagoComPacote
      FROM dbo.Consultas c
      LEFT JOIN dbo.Pacientes p ON p.Id = c.PacienteId
      LEFT JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
      LEFT JOIN dbo.Especialidades e ON e.Id = c.EspecialidadeId
      WHERE c.PacienteId = @PacienteId${statusWhere}
      ORDER BY c.DataHora DESC;
    `);

    return r.recordset || [];
  },

  /**
   * Consultas > Resumo (analytics.vw_FisioConsultasResumo)
   */
  async obterResumoPorFisio(usuario, fisioterapeutaId = null) {
    requireUser(usuario);

    const fid = isAdmin(usuario)
      ? assertId(fisioterapeutaId ?? usuario.id, 'FisioterapeutaId')
      : assertId(usuario.id, 'Usuário');

    const r = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fid);
      req.input('StatusCancelada', sql.NVarChar(30), STATUS.CANCELADA);
      req.input('StatusConcluida', sql.NVarChar(30), STATUS.CONCLUIDA);
      req.input('StatusPacienteAusente', sql.NVarChar(30), STATUS.PACIENTE_AUSENTE);
      req.input('StatusFisioAusente', sql.NVarChar(30), STATUS.FISIOTERAPEUTA_AUSENTE);
    }, `
      IF OBJECT_ID('analytics.vw_FisioConsultasResumo', 'V') IS NULL
      BEGIN
        THROW 50021, 'Tabela analytics.vw_FisioConsultasResumo não encontrada.', 1;
      END

      SELECT TOP 1
        FisioterapeutaId,
        TotalConsultas,
        ConsultasConcluidas,
        ConsultasCanceladas,
        PercentualCancelamento,
        AtualizadoEm
      FROM analytics.vw_FisioConsultasResumo
      WHERE FisioterapeutaId = @FisioterapeutaId;
    `);

    const row = r.recordset?.[0] || null;
    if (!row) {
      return {
        FisioterapeutaId: fid,
        TotalConsultas: 0,
        ConsultasConcluidas: 0,
        ConsultasCanceladas: 0,
        PercentualCancelamento: 0,
        AtualizadoEm: null
      };
    }

    return row;
  },

  /**
   * Consultas > Performance (analytics.vw_FisioPerformanceMensal)
   * Query opcional: ano, mes, limit
   */
  async listarPerformanceMensal(usuario, fisioterapeutaId = null, opts = {}) {
    requireUser(usuario);

    const fid = isAdmin(usuario)
      ? assertId(fisioterapeutaId ?? usuario.id, 'FisioterapeutaId')
      : assertId(usuario.id, 'Usuário');

    const ano = opts?.ano != null && opts.ano !== '' ? assertId(opts.ano, 'Ano') : null;
    const mes = opts?.mes != null && opts.mes !== '' ? assertId(opts.mes, 'Mes') : null;
    if (mes !== null && (mes < 1 || mes > 12)) throw new HttpError(400, 'Mes inválido (1..12).');

    const lim = Number(opts?.limit);
    const topN = Number.isFinite(lim) && lim > 0 && lim <= 120 ? Math.floor(lim) : 24;

    const r = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fid);
      req.input('Ano', sql.Int, ano);
      req.input('Mes', sql.Int, mes);
      req.input('TopN', sql.Int, topN);
    }, `
      IF OBJECT_ID('analytics.vw_FisioPerformanceMensal', 'V') IS NULL
      BEGIN
        THROW 50022, 'Tabela analytics.vw_FisioPerformanceMensal não encontrada.', 1;
      END

      SELECT TOP (@TopN)
        FisioterapeutaId,
        Ano,
        Mes,
        TotalConsultas,
        ConsultasConcluidas,
        ConsultasCanceladas,
        ReceitaLiquida,
        AtualizadoEm
      FROM analytics.vw_FisioPerformanceMensal
      WHERE FisioterapeutaId = @FisioterapeutaId
        AND (@Ano IS NULL OR Ano = @Ano)
        AND (@Mes IS NULL OR Mes = @Mes)
      ORDER BY Ano DESC, Mes DESC;
    `);

    return r.recordset || [];
  },

  /**
   * Cria consulta (paciente cria) - mantém fluxo atual
   */
  async criar(
    { PacienteId, FisioterapeutaId, DataHora, Observacoes = null, ValorConsulta = 0, DuracaoMinutos = null, EspecialidadeId = null },
    usuario = null
  ) {
    const {
      pacienteId,
      fisioterapeutaId,
      dataHora,
      observacoes,
      valorFinal,
      origemAgendamento,
      especialidadeId
    } = await prepararDadosCriacaoConsulta(
      { PacienteId, FisioterapeutaId, DataHora, Observacoes, ValorConsulta, DuracaoMinutos, EspecialidadeId },
      usuario
    );

const spRes = await queryWithContext(usuario, (req) => {
  req.input('PacienteId', sql.Int, pacienteId);
  req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
  req.input('DataHora', sql.DateTime, dataHora);
  req.input('Valor', sql.Decimal(10, 2), valorFinal);
  req.input('OrigemAgendamento', sql.NVarChar(50), origemAgendamento);
  req.input('Observacoes', sql.NVarChar(510), observacoes);
  req.input('EspecialidadeId', sql.Int, especialidadeId);
}, `
  EXEC dbo.SP_CriarConsulta
    @PacienteId = @PacienteId,
    @FisioterapeutaId = @FisioterapeutaId,
    @DataHora = @DataHora,
    @Valor = @Valor,
    @OrigemAgendamento = @OrigemAgendamento,
    @Observacoes = @Observacoes,
    @EspecialidadeId = @EspecialidadeId;
`);

const novoId = spRes?.recordset?.[0]?.ConsultaId;
if (!novoId) throw new HttpError(500, 'Falha ao criar consulta (ConsultaId não retornado).');

    const consulta = await this.buscarPorId(novoId, usuario);

    const consultaOut = isPaciente(usuario)
      ? {
          Id: consulta.Id,
          PacienteId: consulta.PacienteId,
          FisioterapeutaId: consulta.FisioterapeutaId,
          DataHora: consulta.DataHora,
          Status: consulta.Status,
          ValorConsulta: consulta.ValorConsulta,
          StatusPagamento: consulta.StatusPagamento,
          ConfirmadaPor: consulta.ConfirmadaPor ?? null,
          ConfirmadaEm: consulta.ConfirmadaEm ?? null,
          EspecialidadeId: consulta.EspecialidadeId ?? null
        }
      : consulta;

    return { sucesso: true, consulta: consultaOut };
  },

  async opcoesPagamentoPreAgendamento(
    { PacienteId, FisioterapeutaId, DataHora, Observacoes = null, ValorConsulta = 0, DuracaoMinutos = null, EspecialidadeId = null },
    usuario = null
  ) {
    const {
      pacienteId,
      fisioterapeutaId,
      dataHora,
      observacoes,
      valorFinal,
      origemAgendamento,
      especialidadeId
    } = await prepararDadosCriacaoConsulta(
      { PacienteId, FisioterapeutaId, DataHora, Observacoes, ValorConsulta, DuracaoMinutos, EspecialidadeId },
      usuario
    );

    const preview = await queryWithContext(usuario, (req) => {
      req.input('PacienteId', sql.Int, pacienteId);
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      req.input('DataHora', sql.DateTime, dataHora);
      req.input('Valor', sql.Decimal(10, 2), valorFinal);
      req.input('OrigemAgendamento', sql.NVarChar(50), origemAgendamento);
      req.input('Observacoes', sql.NVarChar(510), observacoes);
      req.input('EspecialidadeId', sql.Int, especialidadeId);
    }, `
      BEGIN TRY
        DECLARE @ConsultaCriada TABLE (
          ConsultaId INT,
          PacienteId INT NULL,
          FisioterapeutaId INT NULL,
          ConfirmacaoAutomaticaAtual BIT NULL,
          Status NVARCHAR(60) NULL,
          StatusPagamento NVARCHAR(100) NULL,
          ChatLiberado BIT NULL,
          EspecialidadeId INT NULL
        );

        BEGIN TRAN;

        INSERT INTO @ConsultaCriada (
          ConsultaId,
          PacienteId,
          FisioterapeutaId,
          ConfirmacaoAutomaticaAtual,
          Status,
          StatusPagamento,
          ChatLiberado,
          EspecialidadeId
        )
        EXEC dbo.SP_CriarConsulta
          @PacienteId = @PacienteId,
          @FisioterapeutaId = @FisioterapeutaId,
          @DataHora = @DataHora,
          @Valor = @Valor,
          @OrigemAgendamento = @OrigemAgendamento,
          @Observacoes = @Observacoes,
          @EspecialidadeId = @EspecialidadeId;

        DECLARE @ConsultaId INT = (SELECT TOP 1 ConsultaId FROM @ConsultaCriada);

        IF @ConsultaId IS NULL
          THROW 51001, N'Falha ao simular consulta para pré-checkout.', 1;

        SELECT TOP 1
          c.Id,
          c.PacienteId,
          c.FisioterapeutaId,
          LTRIM(RTRIM(ISNULL(c.Status, N''))) AS Status,
          LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))) AS StatusPagamento,
          ISNULL(c.ValorConsulta, 0) AS ValorConsulta,
          ISNULL(c.IsentoTaxaServico, 0) AS IsentoTaxaServico,
          ISNULL(c.IsentoIntermediacao, 0) AS IsentoIntermediacao,
          c.EspecialidadeId,
          CAST(ISNULL(decv.ValorBase, 0) AS DECIMAL(10,2)) AS ResumoValorSessao,
          CAST(ISNULL(decv.ValorServicoPlataforma, 0) AS DECIMAL(10,2)) AS ResumoTaxaServico,
          CAST(
            CASE
              WHEN ISNULL(c.ValorConsulta, 0)
                   - ISNULL(decv.ValorBase, 0)
                   - ISNULL(decv.ValorServicoPlataforma, 0) < 0
                THEN 0
              ELSE ISNULL(c.ValorConsulta, 0)
                   - ISNULL(decv.ValorBase, 0)
                   - ISNULL(decv.ValorServicoPlataforma, 0)
            END AS DECIMAL(10,2)
          ) AS ResumoTaxaTransacao
        FROM dbo.Consultas c
        OUTER APPLY dbo.fn_DecomporValorPacienteV3(
          CAST(ISNULL(c.ValorConsulta, 0) AS DECIMAL(18,2)),
          N'ConsultaAvulsa',
          1,
          CAST(c.DataHora AS DATE),
          ISNULL(c.IsentoTaxaServico, 0),
          ISNULL(c.IsentoIntermediacao, 0),
          NULL,
          NULL
        ) decv
        WHERE c.Id = @ConsultaId;

        ROLLBACK;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH;

      SELECT ISNULL(SUM(cp.Valor), 0) AS Saldo
      FROM dbo.CreditosPacientes cp
      WHERE cp.PacienteId = @PacienteId
        AND LTRIM(RTRIM(ISNULL(cp.Status, N''))) = N'Disponivel'
        AND cp.UsadoEm IS NULL
        AND cp.PacoteId IS NULL
        AND cp.Valor > 0;

      SELECT COUNT(1) AS TotalSessoesDisponiveis
      FROM dbo.CreditosPacientes cp WITH (READCOMMITTEDLOCK)
      INNER JOIN dbo.Pacotes p WITH (READCOMMITTEDLOCK) ON p.Id = cp.PacoteId
      WHERE cp.PacienteId = @PacienteId
        AND p.FisioterapeutaId = @FisioterapeutaId
        AND (
          @EspecialidadeId IS NULL
          OR p.EspecialidadeId IS NULL
          OR p.EspecialidadeId = @EspecialidadeId
        )
        AND LTRIM(RTRIM(ISNULL(cp.Status, N''))) = N'Disponivel'
        AND cp.UsadoEm IS NULL
        AND cp.ConsultaId IS NULL
        AND LTRIM(RTRIM(ISNULL(p.Status, N''))) = N'Ativo';
    `);

    const row = preview?.recordsets?.[0]?.[0] ?? preview?.recordset?.[0];
    if (!row) {
      throw new HttpError(500, 'Falha ao montar opções de pagamento do pré-checkout.');
    }

    const saldoCarteira = Number(preview?.recordsets?.[1]?.[0]?.Saldo ?? 0) || 0;
    const totalSessoesPacoteDisponiveis =
      Number(preview?.recordsets?.[2]?.[0]?.TotalSessoesDisponiveis ?? 0) || 0;
    const sumarioContrato = await obterSumarioContratoPagamento(usuario);

    const status = String(row.Status || '');
    const statusPagamento = String(row.StatusPagamento || '');
    const valorConsulta = Number(row.ValorConsulta ?? 0) || 0;
    const isIsento =
      Number(row.IsentoTaxaServico ?? 0) === 1 &&
      Number(row.IsentoIntermediacao ?? 0) === 1;

    const encerrada = isTerminalStatus(status) || status === 'Paciente Ausente';
    const jaPaga = statusPagamento === 'Pago' || statusPagamento === 'CreditoPaciente';
    const precisaPagamento = valorConsulta > 0 && !jaPaga && !encerrada;

    return {
      opcoes: {
        ConsultaId: 0,
        StatusPagamento: statusPagamento,
        ValorConsulta: valorConsulta,
        SaldoCarteira: saldoCarteira,
        PodePagarViaPlataforma: precisaPagamento,
        PodePagarForaPlataforma: precisaPagamento && isIsento,
        PodePagarComCreditos: precisaPagamento && saldoCarteira >= valorConsulta,
        PodePagarComPacote: precisaPagamento && totalSessoesPacoteDisponiveis > 0,
        PacotesDisponiveis: totalSessoesPacoteDisponiveis,
        ResumoFinanceiro: {
          ValorSessao: Number(row.ResumoValorSessao ?? 0) || 0,
          TaxaServico: Number(row.ResumoTaxaServico ?? 0) || 0,
          TaxaTransacao: Number(row.ResumoTaxaTransacao ?? 0) || 0,
          Total: valorConsulta
        },
        SumarioContrato: sumarioContrato
      }
    };
  },

  async criarEPagar(
    {
      PacienteId,
      FisioterapeutaId,
      DataHora,
      Observacoes = null,
      ValorConsulta = 0,
      DuracaoMinutos = null,
      EspecialidadeId = null,
      Metodo,
      PacoteId = null,
      DocumentoLegalId = null,
      AceitouSumarioContrato = false,
      IpAceite = null,
      UserAgentAceite = null,
      OrigemAceite = 'AgendamentoConsulta'
    },
    usuario = null
  ) {
    const metodoRaw = String(Metodo ?? '').trim().toLowerCase();
    let metodo = null;
    if (metodoRaw === 'credito' || metodoRaw === 'créditos' || metodoRaw === 'creditos') metodo = 'Credito';
    if (metodoRaw === 'pacote') metodo = 'Pacote';
    if (metodoRaw === 'foraplataforma' || metodoRaw === 'fora_plataforma' || metodoRaw === 'fora-plataforma') metodo = 'ForaPlataforma';
    if (metodoRaw === 'plataforma' || metodoRaw === 'gateway' || metodoRaw === 'asaas') metodo = 'Plataforma';

    if (!metodo) {
      throw new HttpError(400, 'Método de pagamento inválido.');
    }

    const {
      pacienteId,
      fisioterapeutaId,
      dataHora,
      observacoes,
      valorFinal,
      origemAgendamento,
      especialidadeId
    } = await prepararDadosCriacaoConsulta(
      { PacienteId, FisioterapeutaId, DataHora, Observacoes, ValorConsulta, DuracaoMinutos, EspecialidadeId },
      usuario
    );

    let pacoteIdNormalizado =
      PacoteId == null || PacoteId === ''
        ? null
        : assertId(PacoteId, 'PacoteId');
    const documentoLegalId = assertId(DocumentoLegalId, 'DocumentoLegalId');
    const aceiteSumarioContrato = parseBooleanish(AceitouSumarioContrato);
    const ipAceite = normalizeText(IpAceite, 120);
    const userAgentAceite = normalizeText(UserAgentAceite, 800);
    const origemAceite = normalizeText(OrigemAceite, 80) || 'AgendamentoConsulta';

    if (!aceiteSumarioContrato) {
      throw new HttpError(400, 'Você precisa aceitar o sumário do contrato antes de continuar.');
    }

    if (metodo === 'Pacote') {
      const pacoteDisponivelId = await selecionarPacoteDisponivelParaConsulta({
        pacienteId,
        fisioterapeutaId,
        especialidadeId,
        pacoteId: pacoteIdNormalizado
      }, usuario);

      if (!pacoteDisponivelId) {
        throw new HttpError(400, 'Nenhum pacote ativo disponível para esta especialidade.');
      }

      pacoteIdNormalizado = pacoteDisponivelId;
    }

    const result = await queryWithContext(usuario, (req) => {
      req.input('PacienteId', sql.Int, pacienteId);
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      req.input('DataHora', sql.DateTime, dataHora);
      req.input('Valor', sql.Decimal(10, 2), valorFinal);
      req.input('OrigemAgendamento', sql.NVarChar(50), origemAgendamento);
      req.input('Observacoes', sql.NVarChar(510), observacoes);
      req.input('Metodo', sql.NVarChar(40), metodo);
      req.input('PacoteId', sql.Int, pacoteIdNormalizado);
      req.input('DocumentoLegalId', sql.Int, documentoLegalId);
      req.input('AceitouSumarioContrato', sql.Bit, aceiteSumarioContrato ? 1 : 0);
      req.input('IpAceite', sql.NVarChar(120), ipAceite);
      req.input('UserAgentAceite', sql.NVarChar(800), userAgentAceite);
      req.input('OrigemAceite', sql.NVarChar(80), origemAceite);
      req.input('EspecialidadeId', sql.Int, especialidadeId);
    }, `
      BEGIN TRY
        DECLARE @ConsultaCriada TABLE (
          ConsultaId INT,
          PacienteId INT NULL,
          FisioterapeutaId INT NULL,
          ConfirmacaoAutomaticaAtual BIT NULL,
          Status NVARCHAR(60) NULL,
          StatusPagamento NVARCHAR(100) NULL,
          ChatLiberado BIT NULL,
          EspecialidadeId INT NULL
        );
        DECLARE @ConsultaId INT;
        DECLARE @DocumentoLegalIdAtual INT = NULL;
        DECLARE @SqlAceite NVARCHAR(MAX);

        IF ISNULL(@AceitouSumarioContrato, 0) <> 1
          THROW 51003, N'Você precisa aceitar o sumário do contrato antes de continuar.', 1;

        IF OBJECT_ID('dbo.vw_DocumentosLegais_Ativos', 'V') IS NOT NULL
        BEGIN
          SELECT TOP (1)
            @DocumentoLegalIdAtual = d.Id
          FROM dbo.vw_DocumentosLegais_Ativos d
          WHERE d.Tipo = N'CancelamentoReembolso'
          ORDER BY COALESCE(d.AtualizadoEm, d.PublicadoEm) DESC, d.Id DESC;
        END

        IF @DocumentoLegalIdAtual IS NULL
          THROW 51004, N'O sumário do contrato não está disponível no momento.', 1;

        IF @DocumentoLegalIdAtual <> @DocumentoLegalId
          THROW 51005, N'O sumário do contrato foi atualizado. Revise e confirme novamente antes de continuar.', 1;

        BEGIN TRAN;

        INSERT INTO @ConsultaCriada (
          ConsultaId,
          PacienteId,
          FisioterapeutaId,
          ConfirmacaoAutomaticaAtual,
          Status,
          StatusPagamento,
          ChatLiberado,
          EspecialidadeId
        )
        EXEC dbo.SP_CriarConsulta
          @PacienteId = @PacienteId,
          @FisioterapeutaId = @FisioterapeutaId,
          @DataHora = @DataHora,
          @Valor = @Valor,
          @OrigemAgendamento = @OrigemAgendamento,
          @Observacoes = @Observacoes,
          @EspecialidadeId = @EspecialidadeId;

        SET @ConsultaId = (SELECT TOP 1 ConsultaId FROM @ConsultaCriada);

        IF @ConsultaId IS NULL
          THROW 51001, N'Falha ao criar consulta para pagamento.', 1;

        IF COL_LENGTH('dbo.AceitesDocumentosLegais', 'ConsultaId') IS NULL
          THROW 51006, N'Banco desatualizado para registrar o aceite do sumário por consulta.', 1;

        SET @SqlAceite = N'
          IF EXISTS (
            SELECT 1
            FROM dbo.AceitesDocumentosLegais WITH (UPDLOCK, HOLDLOCK)
            WHERE DocumentoLegalId = @DocumentoLegalId
              AND UsuarioTipo = @UsuarioTipo
              AND UsuarioId = @UsuarioId
              AND ConsultaId = @ConsultaId
          )
          BEGIN
            UPDATE dbo.AceitesDocumentosLegais
            SET
              AceitoEm = GETDATE(),
              Ip = @Ip,
              UserAgent = @UserAgent,
              Origem = @Origem
            WHERE DocumentoLegalId = @DocumentoLegalId
              AND UsuarioTipo = @UsuarioTipo
              AND UsuarioId = @UsuarioId
              AND ConsultaId = @ConsultaId;
          END
          ELSE
          BEGIN
            INSERT INTO dbo.AceitesDocumentosLegais
              (DocumentoLegalId, UsuarioTipo, UsuarioId, ConsultaId, AceitoEm, Ip, UserAgent, Origem)
            VALUES
              (@DocumentoLegalId, @UsuarioTipo, @UsuarioId, @ConsultaId, GETDATE(), @Ip, @UserAgent, @Origem);
          END
        ';

        EXEC sp_executesql
          @SqlAceite,
          N'@DocumentoLegalId INT, @UsuarioTipo NVARCHAR(80), @UsuarioId INT, @ConsultaId INT, @Ip NVARCHAR(120), @UserAgent NVARCHAR(800), @Origem NVARCHAR(80)',
          @DocumentoLegalId = @DocumentoLegalIdAtual,
          @UsuarioTipo = N'Paciente',
          @UsuarioId = @PacienteId,
          @ConsultaId = @ConsultaId,
          @Ip = @IpAceite,
          @UserAgent = @UserAgentAceite,
          @Origem = @OrigemAceite;

        IF @Metodo = N'Credito'
        BEGIN
          EXEC dbo.SP_Pagar_ConsultaComCreditoCarteira
            @ConsultaId = @ConsultaId,
            @PacienteId = @PacienteId;
        END
        ELSE IF @Metodo = N'Pacote'
        BEGIN
          EXEC dbo.SP_Consulta_PagarComPacote
            @ConsultaId = @ConsultaId,
            @PacienteId = @PacienteId,
            @PacoteId = @PacoteId;
        END
        ELSE IF @Metodo = N'ForaPlataforma'
        BEGIN
          EXEC dbo.SP_Consulta_MarcarPagaForaPlataforma
            @ConsultaId = @ConsultaId,
            @PacienteId = @PacienteId;
        END
        ELSE IF @Metodo = N'Plataforma'
        BEGIN
          -- Gateway assincrono: consulta permanece com StatusPagamento=Pendente.
          -- A transacao e o checkout sao criados depois em /api/pagamentos/checkout.
          DECLARE @GatewayAssincrono BIT = 1;
        END
        ELSE
        BEGIN
          THROW 51002, N'Método de pagamento não suportado.', 1;
        END

        COMMIT;

        SELECT
          @ConsultaId AS ConsultaId,
          @Metodo AS Metodo;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH;
    `);

    const consultaId = Number(result?.recordset?.[0]?.ConsultaId ?? 0);
    if (!consultaId) {
      throw new HttpError(500, 'Falha ao concluir agendamento com pagamento.');
    }

    await tentarAutoConfirmarConsultaAposPagamento(usuario, consultaId);
    const consulta = await this.buscarPorId(consultaId, usuario);

    const mensagens = {
      Credito: 'Consulta criada e paga com créditos da carteira.',
      Pacote: 'Consulta criada e vinculada a um pacote ativo.',
      ForaPlataforma: 'Consulta criada e marcada como paga fora da plataforma.',
      Plataforma: 'Consulta criada. Continue para o checkout seguro da plataforma.'
    };

    return {
      consulta,
      retorno: {
        Sucesso: true,
        Metodo: metodo,
        ConsultaId: consultaId,
        Mensagem: mensagens[metodo] ?? 'Consulta criada com sucesso.'
      }
    };
  },

    async confirmar(id, usuario) {
    const consultaId = assertId(id, 'Id da consulta');
    requireUser(usuario);

    // Somente Admin ou Fisioterapeuta podem confirmar
    if (!isAdmin(usuario) && !isFisio(usuario)) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const existente = await this.buscarPorId(consultaId, usuario);
    if (!existente) {
      throw new HttpError(404, 'Consulta não encontrada ou sem permissão.');
    }

    // Defesa: não confirma em status final
    if (isTerminalStatus(existente.Status)) {
      throw new HttpError(400, `Consulta não pode ser confirmada pois está em status final (${existente.Status}).`);
    }

    // Defesa: só confirma se estiver Pago (Plataforma ou Isento/ForaPlataforma continuam como "Pago")
    const statusPg = String(existente.StatusPagamento || '').trim();
    if (statusPg !== 'Pago') {
      throw new HttpError(400, 'Consulta só pode ser confirmada, após o pagamento da consulta ter sido realizado. Por favor, Aguarde.');
    }

    // Para a SP, sempre passamos o FisioterapeutaId "real" da consulta
    const fisioId = Number(existente.FisioterapeutaId);
    if (!Number.isFinite(fisioId) || fisioId <= 0) {
      throw new HttpError(400, 'Consulta inválida (FisioterapeutaId ausente).');
    }

    // Fisio só pode confirmar as próprias consultas (buscarPorId + RLS já garante, mas deixamos explícito)
    if (isFisio(usuario) && Number(usuario.id) !== fisioId) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const result = await queryWithContext(
      usuario,
      (req) => {
        req.input('ConsultaId', sql.Int, consultaId);
        req.input('FisioterapeutaId', sql.Int, fisioId);
      },
      `
        EXEC dbo.SP_ConfirmarConsulta
          @ConsultaId = @ConsultaId,
          @FisioterapeutaId = @FisioterapeutaId;
      `
    );

    const retorno = result?.recordset?.[0] ?? null;
    const consulta = await this.buscarPorId(consultaId, usuario);

    return { consulta, retorno };
  },

  //Alias para o fluxo "cancelarArrependimento7Dias" - cancelar-arrependimento-7-dias
 async cancelar(consultaId, dados, usuario) {
  const id = assertId(consultaId, 'consultaId');
  requireUser(usuario);

  const existente = await this.buscarPorId(id, usuario);
  if (!existente) throw new HttpError(404, 'Consulta não encontrada.');

  // Defesa: não cancela em status final
  if (isTerminalStatus(existente.Status)) {
    throw new HttpError(400, 'Consulta já está em status final.');
  }

  // Motivo (opcional)
  const motivo = normalizeText(
    dados?.MotivoEncerramento ?? dados?.Motivo ?? dados?.motivo ?? null,
    400
  );

  // -------------------------------------------------------------------
  //  PACIENTE:
  //  - Consulta paga/crédito: fluxo de arrependimento de 7 dias
  //  - Consulta pendente/não paga: cancelamento direto, sem reembolso
  // -------------------------------------------------------------------
  if (isPaciente(usuario)) {
    const statusPagamento = String(existente.StatusPagamento || '').trim().toLowerCase();

    if (['pago', 'creditopaciente'].includes(statusPagamento)) {
    // mantém compatibilidade de campo (se vier motivoEncerramento etc)
      const body = {
        ...dados,
        Motivo: dados?.Motivo ?? dados?.motivo ?? motivo ?? null,
        motivo: dados?.motivo ?? motivo ?? null
      };

      // Reaproveita o fluxo correto de arrependimento para consultas pagas.
      return await this.cancelarArrependimento7Dias(id, body, usuario);
    }

    const statusAtual = String(existente.Status || '').trim();
    if (!['Aguardando', 'Confirmada'].includes(statusAtual)) {
      throw new HttpError(400, `Consulta não pode ser cancelada neste status: ${statusAtual}`);
    }

    await queryWithContext(
      usuario,
      (req) => {
        req.input('Id', sql.Int, id);
        req.input('PacienteId', sql.Int, Number(usuario.id));
        req.input('Status', sql.NVarChar(60), STATUS.CANCELADA);
        req.input('Motivo', sql.NVarChar(400), motivo);
      },
      `
        UPDATE dbo.Consultas
        SET Status = @Status,
            MotivoEncerramento = COALESCE(@Motivo, MotivoEncerramento),
            DataEncerramento = COALESCE(DataEncerramento, SYSDATETIME()),
            ChatLiberado = 0
        WHERE Id = @Id
          AND PacienteId = @PacienteId;
      `
    );

    await queryWithContext(
      usuario,
      (req) => {
        req.input('ConsultaId', sql.Int, id);
        req.input('PacienteId', sql.Int, Number(usuario.id));
      },
      `
        UPDATE dbo.Transacoes
        SET Status = N'Cancelado'
        WHERE ConsultaId = @ConsultaId
          AND PacienteId = @PacienteId
          AND Status = N'Pendente';
      `
    );

    const consulta = await this.buscarPorId(id, usuario);

    await registrarCancelamentoLog({
      usuario,
      consultaId: id,
      motivo: motivo ?? 'Cancelamento solicitado pelo paciente em consulta sem pagamento confirmado.',
      observacao: 'Fluxo: cancelamento direto do paciente para consulta nao paga.',
      origemAcao: 'consultas.cancelar.paciente',
    });

    return {
      consulta,
      retorno: {
        Sucesso: true,
        ConsultaId: id,
        Mensagem: 'Consulta cancelada com sucesso.'
      }
    };
  }

  // -------------------------------------------------------------------
  //  FISIO: NÃO gerar crédito automaticamente.
  //    Reusa o fluxo já existente/validado de decisão do paciente (no-show-fisio):
  //    - marca a consulta como "Fisioterapeuta Ausente"
  //    - registra log dizendo que foi cancelamento do fisio
  //    - paciente decide: Crédito | Reembolso | Reagendar
  // -------------------------------------------------------------------
  if (isFisio(usuario)) {
    const fisioId = Number(usuario.id);

    // Defesa: Fisioterapeuta só pode "cancelar" (abrir decisão) se a consulta
    // estiver quitada pela plataforma, seja por transação paga ou crédito do paciente.
    const statusPg = String(existente.StatusPagamento || '').trim().toLowerCase();
    if (!['pago', 'creditopaciente'].includes(statusPg)) {
      throw new HttpError(
        400,
        'Fisioterapeuta só pode cancelar consultas pagas (StatusPagamento deve ser Pago ou CreditoPaciente).'
      );
    }

    // Idempotência: se já estiver no estado que abre decisão do paciente, devolve ok
    const statusAtual = String(existente.Status || '').trim();
    if (statusAtual === 'Fisioterapeuta Ausente') {
      return {
        consulta: existente,
        retorno: {
          Sucesso: true,
          ConsultaId: id,
          Mensagem: 'Consulta já estava marcada para decisão do paciente (Crédito/Reembolso/Reagendar).'
        }
      };
    }

    // Opcional: restringir quais status o fisio pode "cancelar"
    // (evita mexer em status inesperados)
    if (!['Aguardando', 'Confirmada'].includes(statusAtual)) {
      throw new HttpError(400, `Consulta não pode ser cancelada pelo fisio neste status: ${statusAtual}`);
    }

    await queryWithContext(
      usuario,
      (req) => {
        req.input('ConsultaId', sql.Int, id);
        req.input('FisioterapeutaId', sql.Int, fisioId);
        req.input('StatusNovo', sql.NVarChar(60), 'Fisioterapeuta Ausente');
        req.input('Motivo', sql.NVarChar(400), motivo);
      },
      `
        -- Marca como "falha do fisio" para habilitar o fluxo já existente de decisão do paciente
        UPDATE dbo.Consultas
        SET
          Status = @StatusNovo,
          DataEncerramento = COALESCE(DataEncerramento, SYSDATETIME()),
          MotivoEncerramento = COALESCE(
            NULLIF(@Motivo, N''),
            MotivoEncerramento,
            N'Cancelado pelo fisioterapeuta (aguardando decisão do paciente)'
          ),
          ChatLiberado = 0
        WHERE Id = @ConsultaId
          AND FisioterapeutaId = @FisioterapeutaId;

        IF OBJECT_ID('dbo.ChatsAtivos', 'U') IS NOT NULL
        BEGIN
          UPDATE dbo.ChatsAtivos
          SET Ativo = 0
          WHERE ConsultaId = @ConsultaId
            AND Ativo = 1;
        END

        IF OBJECT_ID('dbo.ConsultasLogs', 'U') IS NOT NULL
        BEGIN
          INSERT INTO dbo.ConsultasLogs (ConsultaId, Evento, Descricao, UsuarioTipo, UsuarioId)
          VALUES (
            @ConsultaId,
            N'CanceladaPorFisioterapeuta',
            CONCAT(
              N'Cancelamento pelo fisio -> paciente deve decidir: Crédito/Reembolso/Reagendar.',
              CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(@Motivo,N''))),N'') IS NULL THEN N''
                   ELSE CONCAT(N' | ', @Motivo) END
            ),
            N'Fisioterapeuta',
            @FisioterapeutaId
          );
        END
      `
    );

    const consulta = await this.buscarPorId(id, usuario);

    await registrarCancelamentoLog({
      usuario,
      consultaId: id,
      motivo: motivo ?? 'Cancelamento solicitado pelo fisioterapeuta.',
      observacao: 'Fluxo: cancelamento pelo fisioterapeuta com decisao posterior do paciente.',
      origemAcao: 'consultas.cancelar.fisioterapeuta',
    });

    return {
      consulta,
      retorno: {
        Sucesso: true,
        ConsultaId: id,
        Mensagem: 'Cancelamento do fisio registrado. Paciente deve decidir: Crédito/Reembolso/Reagendar.'
      }
    };
  }

  // -------------------------------------------------------------------
  // Admin (fallback): mantém cancelamento via UPDATE direto (sem crédito)
  // -------------------------------------------------------------------
  await queryWithContext(
    usuario,
    (req) => {
      req.input('Id', sql.Int, id);
      req.input('Status', sql.NVarChar(60), STATUS.CANCELADA);
      req.input('Motivo', sql.NVarChar(400), motivo);
    },
    `
      UPDATE dbo.Consultas
      SET Status = @Status,
          MotivoEncerramento = COALESCE(@Motivo, MotivoEncerramento),
          DataEncerramento = COALESCE(DataEncerramento, SYSDATETIME()),
          ChatLiberado = 0
      WHERE Id = @Id;
    `
  );

  const consulta = await this.buscarPorId(id, usuario);

  await registrarCancelamentoLog({
    usuario,
    consultaId: id,
    motivo: motivo ?? 'Cancelamento solicitado pelo administrador.',
    observacao: 'Fluxo: cancelamento administrativo direto.',
    origemAcao: 'consultas.cancelar.admin',
  });

  return { consulta, retorno: null };
},


  async finalizar(id, body, usuario) {
    const consultaId = assertId(id, 'Id de consulta');

    requireUser(usuario);
    if (!isAdmin(usuario)) throw new HttpError(403, 'Acesso negado.');

    const existente = await this.buscarPorId(consultaId, usuario);
    if (!existente) throw new HttpError(404, 'Consulta não encontrada ou sem permissão.');

    if (String(existente.Status) !== STATUS.CONFIRMADA) {
      throw new HttpError(409, `Só finaliza quando estiver Confirmada. Status atual: ${existente.Status}`);
    }

    const motivo = normalizeText(
      body?.MotivoEncerramento ?? body?.motivoEncerramento ?? 'Concluída via API',
      400
    );

    await queryWithContext(usuario, (req) => {
      req.input('Id', sql.Int, consultaId);
      req.input('Motivo', sql.NVarChar(400), motivo);
      req.input('StatusConcluida', sql.NVarChar(30), STATUS.CONCLUIDA);
      req.input('StatusConfirmada', sql.NVarChar(30), STATUS.CONFIRMADA);
    }, `
      UPDATE dbo.Consultas
      SET Status = @StatusConcluida,
          ConfirmacaoAtendimento = 1,
          DataEncerramento = SYSDATETIME(),
          MotivoEncerramento = @Motivo
      WHERE Id = @Id AND Status = @StatusConfirmada;
    `);

    return await this.buscarPorId(consultaId, usuario);
  },

  async definirObservacoes(id, body, usuario) {
    requireUser(usuario);
    if (!isAdmin(usuario) && !isFisio(usuario)) throw new HttpError(403, 'Acesso negado.');

    const existente = await this.buscarPorId(id, usuario);
    if (!existente) throw new HttpError(404, 'Consulta não encontrada ou sem permissão.');

    if (isTerminalStatus(existente.Status)) {
      throw new HttpError(409, `Não é possível alterar observações. Status atual: ${existente.Status}`);
    }

    const texto = normalizeText(body?.Observacoes ?? body?.observacoes ?? null, 510);

    await queryWithContext(usuario, (req) => {
      req.input('Id', sql.Int, Number(id));
      req.input('Observacoes', sql.NVarChar(510), texto);
    }, `
      UPDATE dbo.Consultas
      SET Observacoes = @Observacoes
      WHERE Id = @Id;
    `);

    return await this.buscarPorId(id, usuario);
  },

  async registrarComparecimento(id, body, usuario) {
  const consultaId = assertId(id, 'Id de consulta');

  requireUser(usuario);
  if (!isAdmin(usuario) && !isFisio(usuario)) throw new HttpError(403, 'Acesso negado.');

  const existente = await this.buscarPorId(consultaId, usuario);
  if (!existente) throw new HttpError(404, 'Consulta não encontrada ou sem permissão.');

  const st = String(existente.Status || '');
  if (st !== STATUS.CONFIRMADA) {
    throw new HttpError(
      409,
      `Comparecimento só pode ser registrado em ${STATUS.CONFIRMADA}. Status atual: ${existente.Status}`
    );
  }

  const dataHoraConsulta = new Date(existente?.DataHora ?? 0);
  if (Number.isNaN(dataHoraConsulta.getTime())) {
    throw new HttpError(400, 'Consulta sem DataHora válida para liberar o check-in.');
  }

  const liberaCheckinEm = new Date(
    dataHoraConsulta.getTime() - CHECKIN_ANTECEDENCIA_MIN * 60 * 1000
  );

  if (Date.now() < liberaCheckinEm.getTime()) {
    throw new HttpError(
      409,
      `Check-in só é liberado a partir de ${formatDateTimePtBr(liberaCheckinEm)} (${CHECKIN_ANTECEDENCIA_MIN} min antes da consulta).`
    );
  }

  const lat = parseNumber(body?.latitude ?? body?.CheckinLatitude, 'latitude', { min: -90, max: 90 });
  const lon = parseNumber(body?.longitude ?? body?.CheckinLongitude, 'longitude', { min: -180, max: 180 });
  const evidencia = normalizeText(body?.evidenciaUrl ?? body?.EvidenciaCheckin ?? null, 1000);

  //  Check-in: registra localização/hora/evidência (não valida token e não conclui)
  await queryWithContext(usuario, (req) => {
    req.input('Id', sql.Int, consultaId);
    req.input('CheckinLatitude', sql.Decimal(9, 6), lat);
    req.input('CheckinLongitude', sql.Decimal(9, 6), lon);
    req.input('EvidenciaCheckin', sql.NVarChar(1000), evidencia);
  }, `
    UPDATE dbo.Consultas
    SET CheckinLatitude = COALESCE(@CheckinLatitude, CheckinLatitude),
        CheckinLongitude = COALESCE(@CheckinLongitude, CheckinLongitude),
        CheckinHora = COALESCE(CheckinHora, SYSDATETIME()),
        DataCheckin = COALESCE(DataCheckin, SYSDATETIME()),
        EvidenciaCheckin = COALESCE(@EvidenciaCheckin, EvidenciaCheckin)
    WHERE Id = @Id;
  `);

  //  No "token flow", o token é gerado aqui (idempotente) — paciente apenas visualiza via GET /consultas/:id/token
  let tokenExpiraEm = null;
  let tokenGeradoEm = null;

  const pacienteId = Number(existente.PacienteId);
  if (!Number.isFinite(pacienteId) || pacienteId <= 0) {
    throw new HttpError(400, 'Consulta inválida (PacienteId ausente).');
  }

  const r = await queryWithContext(usuario, (req) => {
    req.input('ConsultaId', sql.Int, consultaId);
    req.input('PacienteId', sql.Int, pacienteId);
    req.input('MinutosExpiracao', sql.Int, TOKEN_EXPIRACAO_MIN);
  }, `
    EXEC dbo.SP_GerarTokenValidacaoConsulta @ConsultaId, @PacienteId, @MinutosExpiracao;
  `);

  const row = r?.recordset?.[0] ?? null;
  tokenExpiraEm = formatSqlLocalDateTime(row?.TokenExpiraEm ?? row?.tokenExpiraEm ?? null);
  tokenGeradoEm = formatSqlLocalDateTime(row?.TokenGeradoEm ?? row?.tokenGeradoEm ?? null);

  const consultaAtualizada = await this.buscarPorId(consultaId, usuario);

  // mantém compatibilidade: pode retornar a consulta direto ou {consulta, tokenExpiraEm}
  return tokenExpiraEm
    ? { consulta: consultaAtualizada, tokenExpiraEm, tokenGeradoEm }
    : consultaAtualizada;
},

  async remover(id, usuario) {
    return await this.cancelar(id, { MotivoEncerramento: 'Cancelada via API' }, usuario);
  },

// REAGENDAR CONSULTA
async reagendar(consultaId, body, usuario) {
  if (!isPaciente(usuario) && !isAdmin(usuario)) {
    throw new HttpError(403, 'Somente Paciente (ou Admin) pode reagendar consulta.');
  }

  const cid = assertId(consultaId, 'ConsultaId');

  const novaDataHoraStr =
    body?.novaDataHora || body?.NovaDataHora || body?.dataHora || body?.DataHora;

  ensureAgendamentoAPartirDeAmanha(novaDataHoraStr, 'NovaDataHora');
  const novaDataHora = parseLocalIsoToUtcNaive(novaDataHoraStr, 'NovaDataHora');

  const motivo = body?.motivo || body?.Motivo || null;

  // Carrega fisio/paciente da consulta (para validar agenda e ownership)
  const rC = await queryWithContext(usuario, (req) => {
    req.input('ConsultaId', sql.Int, cid);
    req.input('PacienteId', sql.Int, isPaciente(usuario) ? Number(usuario.id) : null);
  }, `
    SELECT TOP (1)
      c.Id,
      c.PacienteId,
      c.FisioterapeutaId,
      c.DataHora,
      c.Status
    FROM dbo.Consultas c
    WHERE c.Id = @ConsultaId
      AND (@PacienteId IS NULL OR c.PacienteId = @PacienteId);
  `);

  const c = rC?.recordset?.[0];
  if (!c) throw new HttpError(404, 'Consulta não encontrada para este paciente.');

  // Validador de agenda:
  // - No-show do fisio: NÃO ignora a consulta original (a SP pode criar outra consulta)
  // - Caso normal: ignora a própria consulta (para permitir reagendar sem "auto-conflito")
  const statusAtual = String(c?.Status || '').trim();
  const consultaIdIgnorar = statusAtual === 'Fisioterapeuta Ausente' ? null : cid;

  await validarConflitosAgendamento({
    usuario,
    pacienteId: Number(c.PacienteId),
    fisioterapeutaId: c.FisioterapeutaId,
    dataHora: novaDataHora,
    consultaIdIgnorar
  });

  const r = await queryWithContext(usuario, (req) => {
    req.input('ConsultaId', sql.Int, cid);
    req.input('PacienteId', sql.Int, isPaciente(usuario) ? Number(usuario.id) : Number(c.PacienteId));
    req.input('NovaDataHora', sql.DateTime, novaDataHora);
    req.input('Motivo', sql.NVarChar(400), motivo);
  }, `
    EXEC dbo.SP_ReagendarConsultaPorPaciente
      @ConsultaId   = @ConsultaId,
      @PacienteId   = @PacienteId,
      @NovaDataHora = @NovaDataHora,
      @Motivo       = @Motivo;
  `);

  const res = r?.recordset?.[0];

  // Compatibilidade:
  // - fluxo antigo: retorna { ConsultaId, DataHoraAnterior, DataHoraNova }
  // - no-show fisio (novo): retorna { ConsultaOriginalId, NovaConsultaId, ... }
  // Para não quebrar o front/fluxo, quando vier NovaConsultaId, também expõe ConsultaId = NovaConsultaId.
  if (res?.NovaConsultaId) {
    return {
      ...res,
      ConsultaId: res.NovaConsultaId
    };
  }

  return res ?? { Sucesso: true, ConsultaId: cid };
},


//CANCELAR CONSULTA POR ARREPENDIMENTO (7 DIAS)

  async cancelarArrependimento7Dias(consultaId, body, usuario) {
    if (!isPaciente(usuario)) {
      throw new HttpError(403, 'Somente Paciente pode cancelar por arrependimento (7 dias).');
    }

    const cid = assertId(consultaId, 'ConsultaId');
    const opcaoReembolso = normalizeText(body?.opcaoReembolso ?? body?.OpcaoReembolso, 20);
    if (!opcaoReembolso || !['Credito', 'Reembolso'].includes(opcaoReembolso)) {
      throw new HttpError(400, 'opcaoReembolso inválida. Use Credito ou Reembolso.');
    }

    const motivo = body?.motivo || body?.Motivo || null;
    const rPagamento = await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, cid);
      req.input('PacienteId', sql.Int, Number(usuario.id));
    }, `
      SELECT TOP (1)
        c.Status,
        c.StatusPagamento,
        ISNULL(c.PagamentoViaPlataforma, 0) AS PagamentoViaPlataforma,
        CAST(CASE
          WHEN EXISTS (
            SELECT 1
            FROM dbo.Transacoes t
            WHERE t.ConsultaId = c.Id
              AND t.PacienteId = @PacienteId
              AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago'
          ) THEN 1 ELSE 0
        END AS bit) AS TemTransacaoPaga,
        CAST(CASE
          WHEN EXISTS (
            SELECT 1
            FROM dbo.CreditosPacientes cp
            WHERE cp.PacienteId = @PacienteId
              AND cp.ConsultaId = c.Id
              AND cp.PacoteId IS NULL
          ) THEN 1 ELSE 0
        END AS bit) AS TemCreditoLivre
      FROM dbo.Consultas c
      WHERE c.Id = @ConsultaId
        AND c.PacienteId = @PacienteId;
    `);

    const pagamentoCtx = rPagamento?.recordset?.[0] ?? null;
    if (!pagamentoCtx) {
      throw new HttpError(404, 'Consulta não encontrada para este paciente.');
    }

    const pagamentoViaPlataforma = Number(pagamentoCtx.PagamentoViaPlataforma ?? 0) === 1;
    const statusPagamentoAtual = String(pagamentoCtx.StatusPagamento || '').trim();
    const temTransacaoPaga = !!pagamentoCtx.TemTransacaoPaga;
    const temCreditoLivre = !!pagamentoCtx.TemCreditoLivre;

    if (
      opcaoReembolso === 'Credito' &&
      pagamentoViaPlataforma &&
      ['Pago', 'CreditoPaciente'].includes(statusPagamentoAtual) &&
      temCreditoLivre
    ) {
      const row = await cancelarConsultaPagaComCreditoLivre(cid, Number(usuario.id), motivo, usuario);

      await registrarCancelamentoLog({
        usuario,
        consultaId: cid,
        motivo: motivo ?? 'Cancelamento solicitado pelo paciente.',
        observacao: 'Fluxo: cancelarArrependimento7Dias | credito livre',
        origemAcao: 'consultas.cancelarArrependimento7Dias.creditoLivre',
      });

      return {
        Sucesso: row?.Sucesso ?? true,
        ConsultaId: row?.ConsultaId ?? cid,
        OpcaoReembolso: row?.OpcaoReembolso ?? opcaoReembolso,
        DataCompra: row?.DataCompra ?? null,
        PagamentoViaPlataforma: row?.PagamentoViaPlataforma ?? true,
        SemReembolso: row?.SemReembolso ?? false,
        Mensagem: row?.Mensagem ?? null
      };
    }

    // Mini-guard: se pedir "Reembolso":
    // 1) exige existir Transação "Pago"
    // 2) bloqueia métodos sem estorno em gateway (pacote/crédito em carteira)
    if (opcaoReembolso === 'Reembolso') {
    const rTx = await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, cid);
      req.input('PacienteId', sql.Int, Number(usuario.id));
      }, `
        SELECT TOP (1)
          t.Id AS TransacaoId,
          LTRIM(RTRIM(ISNULL(t.Status, N''))) AS Status,
          LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N''))) AS MetodoPagamento
        FROM dbo.Transacoes t
        WHERE t.ConsultaId = @ConsultaId
          AND t.PacienteId = @PacienteId
        ORDER BY t.Id DESC;
      `);

      const tx = rTx?.recordset?.[0] ?? null;
      const transacaoId = tx?.TransacaoId ?? null;
      const statusTx = tx?.Status ?? null;
      const metodoPagamento = tx?.MetodoPagamento ?? null;

      if (!transacaoId) {
        throw new HttpError(
          400,
          'Opção de Reembolso = "Reembolso" não é permitido: não existe Transação para esta consulta. Use "Credito".'
        );
      }

      if (metodoPagamento === 'Pacote') {
        throw new HttpError(
          400,
          'Consulta paga com PACOTE: Opção de reembolso deve ser "Credito" (estorno do pacote), não "Reembolso".'
        );
      }

      if (metodoPagamento === 'CreditoCarteira') {
        throw new HttpError(
          400,
          'Consulta paga com crédito em carteira: Opção de reembolso deve ser "Credito" (devolução para carteira), não "Reembolso".'
        );
      }

      if (statusTx !== 'Pago') {
        throw new HttpError(
          400,
          `Opção de Reembolso = "Reembolso" não é permitido: A Transação não está "Pago" (status atual: "${statusTx || 'N/A'}"). Use "Credito".`
        );
      }

      const row = await prepararCancelamentoReembolsoAsaasArrependimento(
        cid,
        Number(usuario.id),
        motivo,
        usuario
      );

      const filaReembolso = await reembolsosGatewayFilaService.enfileirarReembolso(
        {
          transacaoId: row?.TransacaoId ?? transacaoId,
          consultaId: cid,
          origem: 'Arrependimento',
          motivo: motivo ?? 'Cancelamento por arrependimento de 7 dias.'
        },
        usuario
      );

      await registrarCancelamentoLog({
        usuario,
        consultaId: cid,
        motivo: motivo ?? 'Cancelamento por arrependimento de 7 dias.',
        observacao: 'Fluxo: cancelarArrependimento7Dias | Reembolso Asaas',
        origemAcao: 'consultas.cancelarArrependimento7Dias.reembolsoAsaas',
      });

      return {
        Sucesso: row?.Sucesso ?? true,
        ConsultaId: row?.ConsultaId ?? cid,
        OpcaoReembolso: 'Reembolso',
        DataCompra: row?.DataCompra ?? null,
        PagamentoViaPlataforma: row?.PagamentoViaPlataforma ?? true,
        SemReembolso: false,
        ReembolsoFilaId: filaReembolso?.Id ?? null,
        ReembolsoGatewayStatus: filaReembolso?.Status ?? 'Pendente',
        ReembolsoConfirmado: false,
        TransacaoId: row?.TransacaoId ?? transacaoId,
        Mensagem: 'Consulta cancelada e reembolso enfileirado para processamento automático.'
      };
    }

    let r;
    try {
      r = await queryWithContext(usuario, (req) => {
        req.input('ConsultaId', sql.Int, cid);
        req.input('PacienteId', sql.Int, Number(usuario.id));
        req.input('OpcaoReembolso', sql.NVarChar(20), opcaoReembolso);
        req.input('Motivo', sql.NVarChar(400), motivo);
      }, `
        -- Observacao de manutencao:
        -- UltimaMovimentacaoEm NAO e setada aqui intencionalmente.
        -- A SP atualiza dbo.CreditosPacientes quando o cancelamento devolve credito,
        -- e o trigger dbo.trg_CreditosPacientes_UltimaMovimentacao preenche esse
        -- campo automaticamente em qualquer UPDATE da tabela. Isso garante que o
        -- extrato do paciente seja ordenado pelo evento mais recente sem depender
        -- de ajustes manuais em cada fluxo.
        EXEC dbo.SP_CancelarConsultaArrependimento7Dias
          @ConsultaId = @ConsultaId,
          @PacienteId = @PacienteId,
          @OpcaoReembolso = @OpcaoReembolso,
          @Motivo = @Motivo;
      `);
    } catch (err) {
      const message = String(err?.message || '').trim();

      if (message.includes('Consulta não encontrada')) {
        throw new HttpError(404, message);
      }

      if (
        message.includes('Cancelamento só é permitido') ||
        message.includes('Fora do prazo de 7 dias do arrependimento') ||
        message.includes('Não foi possível determinar "Data Compra"') ||
        message.includes('já foi cancelada') ||
        message.includes('não pode ser cancelada')
      ) {
        throw new HttpError(409, message);
      }

      throw err;
    }

    const row = r?.recordset?.[0] ?? null;

    if (row && (row.Sucesso === false || Number(row.Sucesso) === 0)) {
      throw new HttpError(409, row.Mensagem || 'Não foi possível cancelar a consulta.');
    }

    await registrarCancelamentoLog({
      usuario,
      consultaId: cid,
      motivo: motivo ?? 'Cancelamento por arrependimento de 7 dias.',
      observacao: `Fluxo: cancelarArrependimento7Dias | OpcaoReembolso=${opcaoReembolso}`,
      origemAcao: 'consultas.cancelarArrependimento7Dias',
    });

      return {
      Sucesso: row?.Sucesso ?? true,
      ConsultaId: row?.ConsultaId ?? cid,
      OpcaoReembolso: row?.OpcaoReembolso ?? opcaoReembolso,
      DataCompra: row?.DataCompra ?? null,
      PagamentoViaPlataforma: row?.PagamentoViaPlataforma ?? null,
      SemReembolso: row?.SemReembolso ?? false,
      Mensagem: row?.Mensagem ?? null
    };

  },

 /**
 * GET /api/consultas/:id/opcoes-no-show-fisio
 * Regras (Paciente):
 * - Baseado em PagamentoViaPlataforma, StatusPagamento e existência de Transacoes(Status='Pago')
 */
async opcoesNoShowFisio(id, usuario) {
  const consultaId = assertId(id, 'Id de consulta');

  requireUser(usuario);
  if (!isPaciente(usuario)) throw new HttpError(403, 'Acesso negado.');

  // Consulta mínima (REMOVIDO NOLOCK -> READCOMMITTEDLOCK)
  const rC = await queryWithContext(usuario, (req) => {
    req.input('ConsultaId', sql.Int, consultaId);
    req.input('PacienteId', sql.Int, Number(usuario.id));
  }, `
    SELECT TOP (1)
      c.Id,
      c.Status,
      c.StatusPagamento,
      c.PagamentoViaPlataforma,
      CASE WHEN (
        EXISTS (
          SELECT 1
          FROM dbo.CreditosPacientes cp
          WHERE cp.ConsultaId = c.Id
            AND cp.PacienteId = @PacienteId
            AND cp.PacoteId IS NOT NULL
        )
        OR EXISTS (
          SELECT 1
          FROM dbo.Transacoes t
          WHERE t.ConsultaId = c.Id
            AND t.PacienteId = @PacienteId
            AND LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N''))) = N'Pacote'
        )
      ) THEN 1 ELSE 0 END AS PagoComPacote
    FROM dbo.Consultas c WITH (READCOMMITTEDLOCK)
    WHERE c.Id = @ConsultaId
      AND c.PacienteId = @PacienteId;
  `);

  const c = rC?.recordset?.[0];
  if (!c) throw new HttpError(404, 'Consulta não encontrada para este paciente.');

  const status = String(c.Status || '').trim();
  if (status !== 'Fisioterapeuta Ausente') {
    throw new HttpError(400, 'Consulta não está com status "Fisioterapeuta Ausente".');
  }

  const statusPagamento = String(c.StatusPagamento || '').trim();
  const pagamentoViaPlataforma = Number(c.PagamentoViaPlataforma ?? 0) === 1;
  const pagoComPacote = Number(c.PagoComPacote ?? 0) === 1;

  // Ajuste 2: alinhar GET com POST -> qualquer decisão existente na consulta
  let decisaoExistente = null;
  {
    const rD = await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, consultaId);
      // PacienteId não é mais necessário aqui, mas mantemos por compatibilidade do builder
      req.input('PacienteId', sql.Int, Number(usuario.id));
    }, `
      SELECT TOP (1)
        CASE
          WHEN Descricao LIKE N'%Opcao=Reembolso%' OR Descricao LIKE N'%REEMBOLSO%' THEN N'Reembolso'
          WHEN Descricao LIKE N'%Opcao=Credito%'   OR Descricao LIKE N'%CRÉDITO%' OR Descricao LIKE N'%CREDITO%' THEN N'Credito'
          WHEN Descricao LIKE N'%Opcao=Reagendar%' OR Descricao LIKE N'%REAGENDAR%' THEN N'Reagendar'
          ELSE NULL
        END AS Decisao
      FROM dbo.ConsultasLogs WITH (READCOMMITTEDLOCK)
      WHERE ConsultaId = @ConsultaId
        AND Evento = N'NoShowFisioDecisao'
      ORDER BY Id DESC;
    `);

    decisaoExistente = rD?.recordset?.[0]?.Decisao ?? null;
  }

  //  cinto de segurança (somente status final inequívoco)
  if (!decisaoExistente && statusPagamento === 'Reembolsado') {
    decisaoExistente = 'Reembolso';
  }

  // Ajuste 5 + 6: sempre calcular TemTransacaoPaga corretamente e sem NOLOCK
  let transacaoId = null;
  let metodoPagamentoTransacao = null;
  if (pagamentoViaPlataforma) {
    const rT = await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, consultaId);
      req.input('PacienteId', sql.Int, Number(usuario.id));
    }, `
      SELECT TOP (1)
        t.Id,
        LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N''))) AS MetodoPagamento
      FROM dbo.Transacoes t WITH (READCOMMITTEDLOCK)
      WHERE t.ConsultaId = @ConsultaId
        AND t.PacienteId = @PacienteId
        AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago'
      ORDER BY t.Id DESC;
    `);
    transacaoId = rT?.recordset?.[0]?.Id ?? null;
    metodoPagamentoTransacao = rT?.recordset?.[0]?.MetodoPagamento ?? null;
  }

  // Se já existe decisão, trava opções e devolve sinalizadores consistentes
  if (decisaoExistente) {
    return {
      ConsultaId: consultaId,
      StatusPagamento: statusPagamento,
      PagamentoViaPlataforma: pagamentoViaPlataforma ? 1 : 0,
      TemTransacaoPaga: !!transacaoId,
      PagoComPacote: pagoComPacote,
      MetodoPagamentoTransacao: metodoPagamentoTransacao,
      DecisaoFinal: decisaoExistente,
      Opcoes: {
        Reagendar: false,
        Credito: false,
        Reembolso: false,
        Disponiveis: []
      }
    };
  }

  const jaPaga = statusPagamento === 'Pago' || statusPagamento === 'CreditoPaciente';
  const podeCredito = pagamentoViaPlataforma && jaPaga;

  // Reembolso só se tiver transação "Pago" (dinheiro) e StatusPagamento = 'Pago'
  const podeReembolso =
    pagamentoViaPlataforma &&
    statusPagamento === 'Pago' &&
    !!transacaoId &&
    !pagoComPacote &&
    String(metodoPagamentoTransacao || '').trim().toLowerCase() !== 'creditocarteira';

  // Reagendar só se não houver decisão
  const podeReagendar = true;

  const disponiveis = [];
  if (podeReagendar) disponiveis.push('Reagendar');
  if (podeCredito) disponiveis.push('Credito');
  if (podeReembolso) disponiveis.push('Reembolso');

  return {
    ConsultaId: consultaId,
    StatusPagamento: statusPagamento,
    PagamentoViaPlataforma: pagamentoViaPlataforma ? 1 : 0,
    TemTransacaoPaga: !!transacaoId,
    PagoComPacote: pagoComPacote,
    MetodoPagamentoTransacao: metodoPagamentoTransacao,
    Opcoes: {
      Reagendar: podeReagendar,
      Credito: podeCredito,
      Reembolso: podeReembolso,
      Disponiveis: disponiveis
    }
  };
},

/**
 * POST /api/consultas/:id/no-show-fisio/decidir
 * Body: { Opcao: 'Reembolso'|'Credito'|'Reagendar', Motivo?: string }
 */
async decidirNoShowFisio(id, body, usuario) {
  if (!isPaciente(usuario)) {
    throw new HttpError(403, 'Somente Paciente pode decidir no-show do fisioterapeuta.');
  }

  const consultaId = assertId(id, 'Id de consulta');

  const opcaoBruta = normalizeText(body?.Opcao || body?.opcao, 20);
  const mapa = { reembolso: 'Reembolso', credito: 'Credito', 'crédito': 'Credito', reagendar: 'Reagendar' };
  const opcao = opcaoBruta ? (mapa[String(opcaoBruta).toLowerCase()] || opcaoBruta) : null;

  if (!opcao || !['Reembolso', 'Credito', 'Reagendar'].includes(opcao)) {
    throw new HttpError(400, 'Opcao inválida. Use Reembolso, Credito ou Reagendar.');
  }

  const motivo = normalizeText(body?.Motivo || body?.motivo || 'No-show do fisioterapeuta.', 500);

  // Carrega opções e também bloqueia escolha fora do permitido
  const opcoes = await this.opcoesNoShowFisio(consultaId, usuario);

  if (!opcoes || typeof opcoes !== 'object' || !opcoes.Opcoes || typeof opcoes.Opcoes !== 'object') {
    throw new HttpError(500, 'Falha ao carregar opções de no-show (estrutura inválida).');
  }

  if (opcao === 'Reembolso' && String(opcoes.MetodoPagamentoTransacao || '').trim().toLowerCase() === 'creditocarteira') {
    throw new HttpError(400, 'Reembolso não disponível para consulta paga com crédito em carteira. Escolha "Credito".');
  }

  // Se opcoesNoShowFisio já veio "travado" por decisão anterior:
  if (opcoes?.DecisaoFinal) {
    if (opcoes.DecisaoFinal === opcao) {
      return {
        Sucesso: true,
        ConsultaId: consultaId,
        Opcao: opcao,
        Mensagem: 'Decisão já registrada anteriormente.'
      };
    }
    throw new HttpError(
      409,
      `Já existe uma decisão registrada (${opcoes.DecisaoFinal}). Não é possível alterar para "${opcao}".`
    );
  }

  // bloqueia escolha fora do permitido
  if (!opcoes.Opcoes[opcao]) {
    if (opcao === 'Reembolso' && opcoes.Opcoes.Credito) {
      throw new HttpError(400, 'Reembolso não disponível para esta consulta. Escolha "Credito".');
    }
    throw new HttpError(400, `Opção "${opcao}" não disponível para esta consulta.`);
  }

  // =========================
  // REAGENDAR (registra decisão e impede trocar depois)
  // =========================
  if (opcao === 'Reagendar') {
    await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, consultaId);
      req.input('PacienteId', sql.Int, Number(usuario.id));
      req.input('Motivo', sql.NVarChar(500), motivo);
    }, `
      SET NOCOUNT ON;
      SET XACT_ABORT ON;

      BEGIN TRY
        BEGIN TRAN;

        DECLARE @LockResult INT;
        DECLARE @ResourceName NVARCHAR(255) =
        N'NoShowFisioDecisao:Consulta:' + CONVERT(NVARCHAR(20), @ConsultaId);
        EXEC @LockResult = sys.sp_getapplock
          @Resource   = @ResourceName,
          @LockMode   = N'Exclusive',
          @LockOwner  = N'Transaction',
          @LockTimeout = 10000;

        IF @LockResult = -1
          THROW 50100, 'Timeout ao obter lock para decisão de no-show (Reagendar). Tente novamente.', 1;

        IF @LockResult < 0
          THROW 50101, 'Não foi possível obter lock para decisão de no-show (Reagendar).', 1;

        DECLARE @Status NVARCHAR(60), @ViaPlataforma BIT;
        SELECT
          @Status = LTRIM(RTRIM(ISNULL(c.Status, N''))),
          @ViaPlataforma = ISNULL(c.PagamentoViaPlataforma, 0)
        FROM dbo.Consultas c WITH (UPDLOCK, HOLDLOCK)
        WHERE c.Id = @ConsultaId AND c.PacienteId = @PacienteId;

        IF @Status IS NULL
          THROW 50110, 'Consulta não encontrada para este paciente.', 1;

        IF @Status <> N'Fisioterapeuta Ausente'
          THROW 50111, 'Consulta não está com status "Fisioterapeuta Ausente".', 1;

        IF OBJECT_ID('dbo.ConsultasLogs', 'U') IS NOT NULL
        BEGIN
          DECLARE @DecisaoExistente NVARCHAR(20) = NULL;

          SELECT TOP (1) @DecisaoExistente =
            CASE
              WHEN Descricao LIKE N'%Opcao=Reembolso%' OR Descricao LIKE N'%REEMBOLSO%' THEN N'Reembolso'
              WHEN Descricao LIKE N'%Opcao=Credito%'   OR Descricao LIKE N'%CRÉDITO%' OR Descricao LIKE N'%CREDITO%' THEN N'Credito'
              WHEN Descricao LIKE N'%Opcao=Reagendar%' OR Descricao LIKE N'%REAGENDAR%' THEN N'Reagendar'
              ELSE NULL
            END
          FROM dbo.ConsultasLogs WITH (READCOMMITTEDLOCK)
          WHERE ConsultaId = @ConsultaId
            AND Evento = N'NoShowFisioDecisao'
          ORDER BY Id DESC;

          IF @DecisaoExistente IS NOT NULL AND @DecisaoExistente <> N'Reagendar'
            THROW 50112, 'Já existe uma decisão registrada para este no-show. Não é possível alterar.', 1;

          IF NOT EXISTS (
            SELECT 1
            FROM dbo.ConsultasLogs WITH (READCOMMITTEDLOCK)
            WHERE ConsultaId = @ConsultaId
              AND Evento = N'NoShowFisioDecisao'
              AND (Descricao LIKE N'%Opcao=Reagendar%' OR Descricao LIKE N'%REAGENDAR%')
          )
          BEGIN
            INSERT INTO dbo.ConsultasLogs (ConsultaId, Evento, Descricao, UsuarioTipo, UsuarioId)
            VALUES (@ConsultaId, N'NoShowFisioDecisao',
                    LEFT(CONCAT(N'No-show fisio | Opcao=Reagendar | Motivo: ', @Motivo), 500),
                    N'Paciente', @PacienteId);
          END
        END

        COMMIT;
      END TRY
      BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;

          DECLARE @EN INT, @ES INT, @EM NVARCHAR(2048), @ThrowState INT;

          SELECT
            @EN = ERROR_NUMBER(),
            @ES = ERROR_STATE(),
            @EM = LEFT(ERROR_MESSAGE(), 2048);

          SET @ThrowState = CASE WHEN @ES BETWEEN 1 AND 255 THEN @ES ELSE 1 END;

          IF @EN >= 50000
            THROW @EN, @EM, @ThrowState;
        THROW 51010, @EM, 1;
      END CATCH
    `);

    return {
      Sucesso: true,
      ConsultaId: consultaId,
      Opcao: 'Reagendar',
      ProximoPasso: 'Use POST /api/consultas/:id/reagendar informando NovaDataHora.'
    };
  }

  // =========================
  // REEMBOLSO (idempotente + clawback se repasse pago)
  // =========================
  if (opcao === 'Reembolso') {
    const r = await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, consultaId);
      req.input('PacienteId', sql.Int, Number(usuario.id));
      req.input('Motivo', sql.NVarChar(500), motivo);
    }, `
      SET NOCOUNT ON;
      SET XACT_ABORT ON;

      BEGIN TRY
        BEGIN TRAN;

        DECLARE @LockResult INT;
        DECLARE @ResourceName NVARCHAR(255) =
        N'NoShowFisioDecisao:Consulta:' + CONVERT(NVARCHAR(20), @ConsultaId);
        EXEC @LockResult = sys.sp_getapplock
          @Resource   = @ResourceName,
          @LockMode   = N'Exclusive',
          @LockOwner  = N'Transaction',
          @LockTimeout = 10000;

        IF @LockResult = -1
          THROW 50000, 'Timeout ao obter lock para decisão de no-show (Reembolso). Tente novamente.', 1;

        IF @LockResult < 0
          THROW 50001, 'Não foi possível obter lock para decisão de no-show (Reembolso).', 1;

        DECLARE @Status NVARCHAR(60), @StatusPg NVARCHAR(60), @ViaPlataforma BIT, @FisioterapeutaId INT;
        SELECT
          @Status = LTRIM(RTRIM(ISNULL(c.Status, N''))),
          @StatusPg = LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))),
          @ViaPlataforma = ISNULL(c.PagamentoViaPlataforma, 0),
          @FisioterapeutaId = c.FisioterapeutaId
        FROM dbo.Consultas c WITH (UPDLOCK, HOLDLOCK)
        WHERE c.Id = @ConsultaId AND c.PacienteId = @PacienteId;

        IF @Status IS NULL
          THROW 50010, 'Consulta não encontrada para este paciente.', 1;

        IF @Status <> N'Fisioterapeuta Ausente'
          THROW 50011, 'Consulta não está com status "Fisioterapeuta Ausente".', 1;

        IF @ViaPlataforma <> 1
          THROW 50012, 'Reembolso não aplicável: PagamentoViaPlataforma=0.', 1;

        IF @StatusPg <> N'Pago'
          THROW 50013, 'Reembolso só é permitido quando StatusPagamento = "Pago".', 1;

        IF OBJECT_ID('dbo.ConsultasLogs', 'U') IS NOT NULL
        BEGIN
          DECLARE @DecisaoExistente NVARCHAR(20) = NULL;

          SELECT TOP (1) @DecisaoExistente =
            CASE
              WHEN Descricao LIKE N'%Opcao=Reembolso%' OR Descricao LIKE N'%REEMBOLSO%' THEN N'Reembolso'
              WHEN Descricao LIKE N'%Opcao=Credito%'   OR Descricao LIKE N'%CRÉDITO%' OR Descricao LIKE N'%CREDITO%' THEN N'Credito'
              WHEN Descricao LIKE N'%Opcao=Reagendar%' OR Descricao LIKE N'%REAGENDAR%' THEN N'Reagendar'
              ELSE NULL
            END
          FROM dbo.ConsultasLogs WITH (READCOMMITTEDLOCK)
          WHERE ConsultaId = @ConsultaId
            AND Evento = N'NoShowFisioDecisao'
          ORDER BY Id DESC;

          IF @DecisaoExistente IS NOT NULL AND @DecisaoExistente <> N'Reembolso'
            THROW 50009, 'Já existe uma decisão registrada para este no-show. Não é possível alterar.', 1;
        END

        DECLARE
          @TransacaoId INT = NULL,
          @TransacaoStatus NVARCHAR(60) = NULL,
          @MetodoPagamentoTransacao NVARCHAR(40) = NULL;

        SELECT TOP (1)
          @TransacaoId = t.Id,
          @TransacaoStatus = LTRIM(RTRIM(ISNULL(t.Status, N''))),
          @MetodoPagamentoTransacao = LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N'')))
        FROM dbo.Transacoes t WITH (UPDLOCK, HOLDLOCK)
        WHERE t.ConsultaId = @ConsultaId
          AND t.PacienteId = @PacienteId
          AND LTRIM(RTRIM(ISNULL(t.Status, N''))) IN (N'Pago', N'Reembolsado')
        ORDER BY t.Id DESC;

        IF @TransacaoId IS NULL
          THROW 50014, 'Reembolso não disponível: não existe Transação "Pago" (ou já reembolsada) para esta consulta.', 1;

        IF @MetodoPagamentoTransacao = N'CreditoCarteira'
          THROW 50015, 'Reembolso não disponível para consulta paga com crédito em carteira. Escolha Credito.', 1;

        IF OBJECT_ID('dbo.Repasses', 'U') IS NOT NULL
        BEGIN
          UPDATE r
            SET r.Status = N'Cancelado'
          FROM dbo.Repasses r
          WHERE r.TransacaoId = @TransacaoId
            AND LTRIM(RTRIM(ISNULL(r.Status, N''))) = N'Pendente';
        END

        IF OBJECT_ID('dbo.AjustesRepasses', 'U') IS NOT NULL
          AND OBJECT_ID('dbo.Repasses', 'U') IS NOT NULL
        BEGIN
          DECLARE @ValorDebito DECIMAL(10,2) = NULL;

          SELECT TOP (1) @ValorDebito = r.ValorLiquido
          FROM dbo.Repasses r WITH (UPDLOCK, HOLDLOCK)
          WHERE r.TransacaoId = @TransacaoId
            AND LTRIM(RTRIM(ISNULL(r.Status, N''))) = N'Pago'
          ORDER BY r.Id DESC;

          IF @ValorDebito IS NOT NULL AND @ValorDebito > 0
          BEGIN
            IF @TransacaoStatus = N'Pago' AND OBJECT_ID('dbo.SP_RegistrarClawbackSeRepassePago', 'P') IS NOT NULL
            BEGIN
              BEGIN TRY
                DECLARE @MotivoClawback NVARCHAR(500) =
                  LEFT(CONCAT(N'Estorno ao paciente. ', @Motivo), 500);

                EXEC dbo.SP_RegistrarClawbackSeRepassePago
                  @ConsultaId = @ConsultaId,
                  @DisputaId  = NULL,
                  @Motivo     = @MotivoClawback;
              END TRY
              BEGIN CATCH
                -- best-effort: clawback NÃO pode quebrar o reembolso
                -- (se quiser depois, dá pra registrar log em ConsultasLogs aqui)
              END CATCH
            END
            ELSE
            BEGIN
              IF NOT EXISTS (
                SELECT 1
                FROM dbo.AjustesRepasses ar WITH (UPDLOCK, HOLDLOCK)
                WHERE ar.TransacaoId = @TransacaoId
                  AND ar.Tipo = N'Clawback'
                  AND ar.Status = N'Pendente'
              )
              BEGIN
                INSERT INTO dbo.AjustesRepasses
                  (FisioterapeutaId, TransacaoId, ConsultaId, DisputaId, Tipo, Status, ValorOriginal, ValorPendente, Motivo)
                VALUES
                  (@FisioterapeutaId, @TransacaoId, @ConsultaId, NULL,
                  N'Clawback', N'Pendente', @ValorDebito, @ValorDebito,
                  LEFT(CONCAT(N'Estorno automático. ', @Motivo), 500));
              END
            END
          END
        END

        IF @TransacaoStatus = N'Reembolsado'
        BEGIN
          UPDATE dbo.Consultas
            SET StatusPagamento = N'Reembolsado'
          WHERE Id = @ConsultaId;

          IF OBJECT_ID('dbo.ConsultasLogs', 'U') IS NOT NULL
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM dbo.ConsultasLogs WITH (READCOMMITTEDLOCK)
              WHERE ConsultaId = @ConsultaId
                AND Evento = N'NoShowFisioDecisao'
                AND (Descricao LIKE N'%Opcao=Reembolso%' OR Descricao LIKE N'%REEMBOLSO%')
            )
            BEGIN
              INSERT INTO dbo.ConsultasLogs (ConsultaId, Evento, Descricao, UsuarioTipo, UsuarioId)
              VALUES (@ConsultaId, N'NoShowFisioDecisao',
                      LEFT(CONCAT(N'No-show fisio | Opcao=Reembolso | Motivo: ', @Motivo), 500),
                      N'Paciente', @PacienteId);
            END
          END

          COMMIT;

          SELECT
            CAST(1 AS bit) AS Sucesso,
            @ConsultaId AS ConsultaId,
            N'Reembolso' AS Opcao,
            @TransacaoId AS TransacaoId,
            N'Reembolso já estava aplicado (idempotente).' AS Mensagem;
          RETURN;
        END

        UPDATE dbo.Transacoes
          SET Status = N'Reembolsado'
        WHERE Id = @TransacaoId
          AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'Pago';

        UPDATE dbo.Consultas
          SET StatusPagamento = N'Reembolsado'
        WHERE Id = @ConsultaId;

        IF OBJECT_ID('dbo.ConsultasLogs', 'U') IS NOT NULL
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM dbo.ConsultasLogs WITH (READCOMMITTEDLOCK)
            WHERE ConsultaId = @ConsultaId
              AND Evento = N'NoShowFisioDecisao'
              AND (Descricao LIKE N'%Opcao=Reembolso%' OR Descricao LIKE N'%REEMBOLSO%')
          )
          BEGIN
            INSERT INTO dbo.ConsultasLogs (ConsultaId, Evento, Descricao, UsuarioTipo, UsuarioId)
            VALUES (@ConsultaId, N'NoShowFisioDecisao',
                    LEFT(CONCAT(N'No-show fisio | Opcao=Reembolso | Motivo: ', @Motivo), 500),
                    N'Paciente', @PacienteId);
          END
        END

        COMMIT;

        SELECT
          CAST(1 AS bit) AS Sucesso,
          @ConsultaId AS ConsultaId,
          N'Reembolso' AS Opcao,
          @TransacaoId AS TransacaoId,
          N'Estorno solicitado.' AS Mensagem;

      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        DECLARE @EN INT, @ES INT, @EM NVARCHAR(2048), @ThrowState INT;

        SELECT
          @EN = ERROR_NUMBER(),
          @ES = ERROR_STATE(),
          @EM = LEFT(ERROR_MESSAGE(), 2048);

        SET @ThrowState = CASE WHEN @ES BETWEEN 1 AND 255 THEN @ES ELSE 1 END;

        IF @EN >= 50000
          THROW @EN, @EM, @ThrowState;
        THROW 51000, @EM, 1;
      END CATCH
    `);

    return r?.recordset?.[0] ?? { Sucesso: true, ConsultaId: consultaId, Opcao: 'Reembolso' };
  }

  // =========================
  // CRÉDITO (idempotente + clawback se repasse pago + motivo sem duplicar + sem truncar)
  // =========================
  {
    const r = await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, consultaId);
      req.input('PacienteId', sql.Int, Number(usuario.id));
      req.input('Motivo', sql.NVarChar(500), motivo);
    }, `
      SET NOCOUNT ON;
      SET XACT_ABORT ON;

      BEGIN TRY
        BEGIN TRAN;

        DECLARE @LockResult INT;
        DECLARE @ResourceName NVARCHAR(255) =
        N'NoShowFisioDecisao:Consulta:' + CONVERT(NVARCHAR(20), @ConsultaId);
        EXEC @LockResult = sys.sp_getapplock
          @Resource   = @ResourceName,
          @LockMode   = N'Exclusive',
          @LockOwner  = N'Transaction',
          @LockTimeout = 10000;

        IF @LockResult = -1
          THROW 50003, 'Timeout ao obter lock para decisão de no-show (Crédito). Tente novamente.', 1;

        IF @LockResult < 0
          THROW 50002, 'Não foi possível obter lock para decisão de no-show (Crédito).', 1;

        DECLARE @Status NVARCHAR(60), @StatusPg NVARCHAR(60), @ViaPlataforma BIT, @Valor DECIMAL(10,2), @FisioterapeutaId INT;
        SELECT
          @Status = LTRIM(RTRIM(ISNULL(c.Status, N''))),
          @StatusPg = LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))),
          @ViaPlataforma = ISNULL(c.PagamentoViaPlataforma, 0),
          @Valor = TRY_CONVERT(DECIMAL(10,2), c.ValorConsulta),
          @FisioterapeutaId = c.FisioterapeutaId
        FROM dbo.Consultas c WITH (UPDLOCK, HOLDLOCK)
        WHERE c.Id = @ConsultaId AND c.PacienteId = @PacienteId;

        IF @Status IS NULL
          THROW 50020, 'Consulta não encontrada para este paciente.', 1;

        IF @Status <> N'Fisioterapeuta Ausente'
          THROW 50021, 'Consulta não está com status "Fisioterapeuta Ausente".', 1;

        IF @ViaPlataforma <> 1
          THROW 50022, 'Crédito não aplicável: PagamentoViaPlataforma=0.', 1;

        IF @StatusPg NOT IN (N'Pago', N'CreditoPaciente')
          THROW 50023, 'Crédito só é permitido quando StatusPagamento = "Pago" ou "CreditoPaciente".', 1;

        IF OBJECT_ID('dbo.ConsultasLogs', 'U') IS NOT NULL
        BEGIN
          DECLARE @DecisaoExistente NVARCHAR(20) = NULL;

          SELECT TOP (1) @DecisaoExistente =
            CASE
              WHEN Descricao LIKE N'%Opcao=Reembolso%' OR Descricao LIKE N'%REEMBOLSO%' THEN N'Reembolso'
              WHEN Descricao LIKE N'%Opcao=Credito%'   OR Descricao LIKE N'%CRÉDITO%' OR Descricao LIKE N'%CREDITO%' THEN N'Credito'
              WHEN Descricao LIKE N'%Opcao=Reagendar%' OR Descricao LIKE N'%REAGENDAR%' THEN N'Reagendar'
              ELSE NULL
            END
          FROM dbo.ConsultasLogs WITH (READCOMMITTEDLOCK)
          WHERE ConsultaId = @ConsultaId
            AND Evento = N'NoShowFisioDecisao'
          ORDER BY Id DESC;

          IF @DecisaoExistente IS NOT NULL AND @DecisaoExistente <> N'Credito'
            THROW 50019, 'Já existe uma decisão registrada para este no-show. Não é possível alterar.', 1;
        END

        DECLARE @MotivoKey NVARCHAR(160) =
          CONCAT(N'Estorno da consulta ', CONVERT(NVARCHAR(20), @ConsultaId), N' referente a fisioterapeuta Ausente');

        DECLARE @MotivoMaxBytes INT = COL_LENGTH('dbo.CreditosPacientes', 'Motivo');
        DECLARE @MotivoMaxChars INT = CASE
          WHEN @MotivoMaxBytes IS NULL OR @MotivoMaxBytes <= 0 THEN 400
          ELSE (@MotivoMaxBytes / 2)
        END;

        DECLARE @MotivoCredito NVARCHAR(4000) = CONCAT(
          @MotivoKey,
          CASE
            WHEN NULLIF(LTRIM(RTRIM(ISNULL(@Motivo, N''))), N'') IS NULL THEN N''
            ELSE CONCAT(N' | ', LEFT(LTRIM(RTRIM(@Motivo)), 250))
          END
        );
        SET @MotivoCredito = LEFT(@MotivoCredito, @MotivoMaxChars);

        DECLARE @TransacaoId INT = NULL, @TransacaoStatus NVARCHAR(60) = NULL, @MetodoPagamentoTransacao NVARCHAR(40) = NULL;

        SELECT TOP (1)
          @TransacaoId = t.Id,
          @TransacaoStatus = LTRIM(RTRIM(ISNULL(t.Status, N''))),
          @MetodoPagamentoTransacao = LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N'')))
        FROM dbo.Transacoes t WITH (UPDLOCK, HOLDLOCK)
        WHERE t.ConsultaId = @ConsultaId
          AND t.PacienteId = @PacienteId
          AND LTRIM(RTRIM(ISNULL(t.Status, N''))) IN (N'Pago', N'Reembolsado')
        ORDER BY t.Id DESC;

        IF @TransacaoId IS NOT NULL
        BEGIN
          IF OBJECT_ID('dbo.Repasses', 'U') IS NOT NULL
          BEGIN
            UPDATE r
              SET r.Status = N'Cancelado'
            FROM dbo.Repasses r
            WHERE r.TransacaoId = @TransacaoId
              AND LTRIM(RTRIM(ISNULL(r.Status, N''))) = N'Pendente';
          END

          IF OBJECT_ID('dbo.SP_RegistrarClawbackSeRepassePago', 'P') IS NOT NULL
          BEGIN
            BEGIN TRY
              DECLARE @MotivoClawback NVARCHAR(500) =
                LEFT(CONCAT(N'Estorno ao paciente. ', COALESCE(NULLIF(LTRIM(RTRIM(@Motivo)), N''), N'')), 500);

              EXEC dbo.SP_RegistrarClawbackSeRepassePago
                @ConsultaId = @ConsultaId,
                @DisputaId  = NULL,
                @Motivo     = @MotivoClawback;
            END TRY
            BEGIN CATCH
              -- best-effort: clawback não pode quebrar o crédito
            END CATCH
          END          
        END

        IF OBJECT_ID('dbo.CreditosPacientes', 'U') IS NULL
          THROW 50024, 'Tabela dbo.CreditosPacientes não encontrada.', 1;

        DECLARE @CreditosPacoteEstornados TABLE (PacoteId INT NULL);

        IF COL_LENGTH('dbo.CreditosPacientes', 'ConsultaId') IS NOT NULL
        BEGIN
          IF @MetodoPagamentoTransacao = N'CreditoCarteira'
          BEGIN
            DECLARE @CreditosCarteiraRestaurados INT = 0;

            UPDATE dbo.CreditosPacientes
              SET Status = N'Disponivel',
                  UsadoEm = NULL,
                  OrigemConsultaId = COALESCE(OrigemConsultaId, @ConsultaId),
                  ConsultaId = NULL,
                  Motivo = @MotivoCredito
            WHERE PacienteId = @PacienteId
              AND ConsultaId = @ConsultaId
              AND PacoteId IS NULL;

            SET @CreditosCarteiraRestaurados = @@ROWCOUNT;

            IF @CreditosCarteiraRestaurados = 0
               AND NOT EXISTS (
                 SELECT 1
                 FROM dbo.CreditosPacientes cp WITH (UPDLOCK, HOLDLOCK)
                 WHERE cp.PacienteId = @PacienteId
                   AND cp.PacoteId IS NULL
                   AND (
                     cp.ConsultaId = @ConsultaId
                     OR (cp.OrigemConsultaId = @ConsultaId AND cp.ConsultaId IS NULL)
                   )
               )
            BEGIN
              INSERT INTO dbo.CreditosPacientes (PacienteId, ConsultaId, OrigemConsultaId, Valor, Status, UsadoEm, Motivo)
              VALUES (@PacienteId, NULL, @ConsultaId, COALESCE(@Valor, 0), N'Disponivel', NULL, @MotivoCredito);

              SET @CreditosCarteiraRestaurados = 1;
            END

            UPDATE dbo.Consultas
              SET StatusPagamento = N'CreditoPaciente'
            WHERE Id = @ConsultaId;

            IF @TransacaoId IS NOT NULL AND @TransacaoStatus = N'Pago'
            BEGIN
              UPDATE dbo.Transacoes
                SET Status = N'Reembolsado'
              WHERE Id = @TransacaoId
                AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'Pago';

              IF OBJECT_ID('dbo.LogsFinanceiros', 'U') IS NOT NULL
              BEGIN
                IF NOT EXISTS (
                  SELECT 1
                  FROM dbo.LogsFinanceiros lf WITH (READCOMMITTEDLOCK)
                  WHERE lf.TransacaoId = @TransacaoId
                    AND LTRIM(RTRIM(ISNULL(lf.Acao, N''))) IN (N'Estorno', N'Reembolsado')
                )
                BEGIN
                  INSERT INTO dbo.LogsFinanceiros (TransacaoId, RepasseId, Usuario, Acao, DataAcao, Observacao)
                  VALUES (@TransacaoId, NULL, N'Sistema', N'Estorno', SYSDATETIME(), N'Transação status: Reembolsado');
                END
              END
            END

            IF OBJECT_ID('dbo.ConsultasLogs', 'U') IS NOT NULL
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM dbo.ConsultasLogs WITH (READCOMMITTEDLOCK)
                WHERE ConsultaId = @ConsultaId
                  AND Evento = N'NoShowFisioDecisao'
                  AND (Descricao LIKE N'%Opcao=Credito%' OR Descricao LIKE N'%CRÉDITO%' OR Descricao LIKE N'%CREDITO%')
              )
              BEGIN
                INSERT INTO dbo.ConsultasLogs (ConsultaId, Evento, Descricao, UsuarioTipo, UsuarioId)
                VALUES (@ConsultaId, N'NoShowFisioDecisao',
                        LEFT(CONCAT(N'No-show fisio | Opcao=Credito | Motivo: ', @MotivoCredito), 500),
                        N'Paciente', @PacienteId);
              END
            END

            COMMIT;

            SELECT
              CAST(1 AS bit) AS Sucesso,
              @ConsultaId AS ConsultaId,
              N'Credito' AS Opcao,
              COALESCE(@Valor, 0) AS ValorCredito,
              CASE
                WHEN @CreditosCarteiraRestaurados > 0
                  THEN N'Crédito devolvido para a carteira.'
                ELSE N'Crédito já estava disponível (idempotente).'
              END AS Mensagem;
            RETURN;
          END

          IF EXISTS (
            SELECT 1
            FROM dbo.CreditosPacientes cp WITH (UPDLOCK, HOLDLOCK)
            WHERE cp.PacienteId = @PacienteId
              AND (
                cp.ConsultaId = @ConsultaId
                OR (cp.OrigemConsultaId = @ConsultaId AND cp.ConsultaId IS NULL)
              )
              AND LTRIM(RTRIM(ISNULL(cp.Status, N''))) = N'Disponivel'
          )
          BEGIN
            UPDATE dbo.CreditosPacientes
              SET Valor  = COALESCE(@Valor, Valor),
                  OrigemConsultaId = COALESCE(OrigemConsultaId, @ConsultaId),
                  ConsultaId = NULL,
                  Motivo = @MotivoCredito
              OUTPUT CASE
                WHEN deleted.ConsultaId = @ConsultaId AND inserted.PacoteId IS NOT NULL THEN inserted.PacoteId
                ELSE NULL
              END INTO @CreditosPacoteEstornados (PacoteId)
            WHERE PacienteId = @PacienteId
              AND (
                ConsultaId = @ConsultaId
                OR (OrigemConsultaId = @ConsultaId AND ConsultaId IS NULL)
              );

            ;WITH PacotesImpactados AS (
              SELECT PacoteId, COUNT(1) AS Quantidade
              FROM @CreditosPacoteEstornados
              WHERE PacoteId IS NOT NULL
              GROUP BY PacoteId
            )
            UPDATE p
              SET ConsultasUtilizadas = CASE
                WHEN ISNULL(p.ConsultasUtilizadas, 0) > pi.Quantidade
                  THEN ISNULL(p.ConsultasUtilizadas, 0) - pi.Quantidade
                ELSE 0
              END
            FROM dbo.Pacotes p
            INNER JOIN PacotesImpactados pi
              ON pi.PacoteId = p.Id;

              UPDATE dbo.Consultas
              SET StatusPagamento = N'CreditoPaciente'
            WHERE Id = @ConsultaId;

            -- NOVO: refletir estorno (crédito) na Transação e no Log Financeiro
            IF @TransacaoId IS NOT NULL AND @TransacaoStatus = N'Pago'
            BEGIN
              UPDATE dbo.Transacoes
                SET Status = N'Reembolsado'
              WHERE Id = @TransacaoId
                AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'Pago';

              IF OBJECT_ID('dbo.LogsFinanceiros', 'U') IS NOT NULL
              BEGIN
                IF NOT EXISTS (
                  SELECT 1
                  FROM dbo.LogsFinanceiros lf WITH (READCOMMITTEDLOCK)
                  WHERE lf.TransacaoId = @TransacaoId
                  AND LTRIM(RTRIM(ISNULL(lf.Acao, N''))) IN (N'Estorno', N'Reembolsado')
                )
                BEGIN
                  INSERT INTO dbo.LogsFinanceiros (TransacaoId, RepasseId, Usuario, Acao, DataAcao, Observacao)
                  VALUES (@TransacaoId, NULL, N'Sistema', N'Estorno', SYSDATETIME(), N'Transação status: Reembolsado');
                END
              END
            END

            IF OBJECT_ID('dbo.ConsultasLogs', 'U') IS NOT NULL
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM dbo.ConsultasLogs WITH (READCOMMITTEDLOCK)
                WHERE ConsultaId = @ConsultaId
                AND Evento = N'NoShowFisioDecisao'
                AND (Descricao LIKE N'%Opcao=Credito%' OR Descricao LIKE N'%CRÉDITO%' OR Descricao LIKE N'%CREDITO%')
              )
              BEGIN
                INSERT INTO dbo.ConsultasLogs (ConsultaId, Evento, Descricao, UsuarioTipo, UsuarioId)
                VALUES (@ConsultaId, N'NoShowFisioDecisao',
                LEFT(CONCAT(N'No-show fisio | Opcao=Credito | Motivo: ', @MotivoCredito), 500),
                N'Paciente', @PacienteId);
              END
            END

            COMMIT;

            SELECT
              CAST(1 AS bit) AS Sucesso,
              @ConsultaId AS ConsultaId,
              N'Credito' AS Opcao,
              COALESCE(@Valor, 0) AS ValorCredito,
              N'Crédito já estava disponível (idempotente).' AS Mensagem;
            RETURN;
          END

          IF EXISTS (
            SELECT 1
            FROM dbo.CreditosPacientes cp WITH (UPDLOCK, HOLDLOCK)
            WHERE cp.PacienteId = @PacienteId AND cp.ConsultaId = @ConsultaId
          )
          BEGIN
            UPDATE dbo.CreditosPacientes
              SET Status = N'Disponivel',
                  UsadoEm = NULL,
                  Valor = COALESCE(@Valor, Valor),
                  OrigemConsultaId = COALESCE(OrigemConsultaId, @ConsultaId),
                  ConsultaId = NULL,
                  Motivo = @MotivoCredito
              OUTPUT CASE
                WHEN inserted.PacoteId IS NOT NULL THEN inserted.PacoteId
                ELSE NULL
              END INTO @CreditosPacoteEstornados (PacoteId)
            WHERE PacienteId = @PacienteId AND ConsultaId = @ConsultaId;
          END
          ELSE IF NOT EXISTS (
            SELECT 1
            FROM dbo.CreditosPacientes cp WITH (UPDLOCK, HOLDLOCK)
            WHERE cp.PacienteId = @PacienteId
              AND cp.OrigemConsultaId = @ConsultaId
          )
          BEGIN
            INSERT INTO dbo.CreditosPacientes (PacienteId, ConsultaId, OrigemConsultaId, Valor, Status, UsadoEm, Motivo)
            VALUES (@PacienteId, NULL, @ConsultaId, COALESCE(@Valor, 0), N'Disponivel', NULL, @MotivoCredito);
          END
        END
        ELSE
        BEGIN
          THROW 50025, 'Coluna dbo.CreditosPacientes.ConsultaId não encontrada.', 1;
        END

        ;WITH PacotesImpactados AS (
          SELECT PacoteId, COUNT(1) AS Quantidade
          FROM @CreditosPacoteEstornados
          WHERE PacoteId IS NOT NULL
          GROUP BY PacoteId
        )
        UPDATE p
          SET ConsultasUtilizadas = CASE
            WHEN ISNULL(p.ConsultasUtilizadas, 0) > pi.Quantidade
              THEN ISNULL(p.ConsultasUtilizadas, 0) - pi.Quantidade
            ELSE 0
          END
        FROM dbo.Pacotes p
        INNER JOIN PacotesImpactados pi
          ON pi.PacoteId = p.Id;

        UPDATE dbo.Consultas
          SET StatusPagamento = N'CreditoPaciente'
        WHERE Id = @ConsultaId;

        -- NOVO: refletir estorno (crédito) na Transação e no Log Financeiro
        IF @TransacaoId IS NOT NULL AND @TransacaoStatus = N'Pago'
        BEGIN
          UPDATE dbo.Transacoes
            SET Status = N'Reembolsado'
          WHERE Id = @TransacaoId
            AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'Pago';

          IF OBJECT_ID('dbo.LogsFinanceiros', 'U') IS NOT NULL
          BEGIN
            IF NOT EXISTS (
              SELECT 1
              FROM dbo.LogsFinanceiros lf WITH (READCOMMITTEDLOCK)
              WHERE lf.TransacaoId = @TransacaoId
                AND LTRIM(RTRIM(ISNULL(lf.Acao, N''))) IN (N'Estorno', N'Reembolsado')
            )
            BEGIN
              INSERT INTO dbo.LogsFinanceiros (TransacaoId, RepasseId, Usuario, Acao, DataAcao, Observacao)
              VALUES (@TransacaoId, NULL, N'Sistema', N'Estorno', SYSDATETIME(), N'Transação status: Reembolsado');
            END
          END
        END

        IF OBJECT_ID('dbo.ConsultasLogs', 'U') IS NOT NULL
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM dbo.ConsultasLogs WITH (READCOMMITTEDLOCK)
            WHERE ConsultaId = @ConsultaId
              AND Evento = N'NoShowFisioDecisao'
              AND (Descricao LIKE N'%Opcao=Credito%' OR Descricao LIKE N'%CRÉDITO%' OR Descricao LIKE N'%CREDITO%')
          )
          BEGIN
            INSERT INTO dbo.ConsultasLogs (ConsultaId, Evento, Descricao, UsuarioTipo, UsuarioId)
            VALUES (@ConsultaId, N'NoShowFisioDecisao',
                    LEFT(CONCAT(N'No-show fisio | Opcao=Credito | Motivo: ', @MotivoCredito), 500),
                    N'Paciente', @PacienteId);
          END
        END

        COMMIT;


        SELECT
          CAST(1 AS bit) AS Sucesso,
          @ConsultaId AS ConsultaId,
          N'Credito' AS Opcao,
          COALESCE(@Valor, 0) AS ValorCredito,
          N'Crédito disponibilizado na carteira.' AS Mensagem;

      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        DECLARE @EN INT, @ES INT, @EM NVARCHAR(2048), @ThrowState INT;

        SELECT
          @EN = ERROR_NUMBER(),
          @ES = ERROR_STATE(),
          @EM = LEFT(ERROR_MESSAGE(), 2048);

        SET @ThrowState = CASE WHEN @ES BETWEEN 1 AND 255 THEN @ES ELSE 1 END;

        IF @EN >= 50000
          THROW @EN, @EM, @ThrowState;
        THROW 51001, @EM, 1;
      END CATCH
    `);

    await reconciliarCreditoPacoteDisponivelPorConsulta(consultaId, usuario);

    return r?.recordset?.[0] ?? { Sucesso: true, ConsultaId: consultaId, Opcao: 'Credito' };
  }
},


  /**
   * GET /consultas/:id/pagamento/opcoes
   * Retorna quais opções de pagamento devem aparecer para o paciente.
   * - Via plataforma (gateway): sempre disponível quando ValorConsulta > 0
   * - Fora da plataforma: somente se IsentoTaxaServico=1 e IsentoIntermediacao=1
   * - Carteira (créditos): somente se saldo disponível >= ValorConsulta
   */
  async opcoesPagamento(id, usuario) {
    const consultaId = assertId(id, 'Id de consulta');

    requireUser(usuario);
    if (!isAdmin(usuario) && !isPaciente(usuario)) throw new HttpError(403, 'Acesso negado.');

    // Consulta mínima para calcular opções (precisamos das flags de isenção, que não aparecem no "detalhe" do paciente)
    const wherePaciente = isPaciente(usuario) ? ' AND c.PacienteId = @PacienteId' : '';

    const base = await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, consultaId);
      if (isPaciente(usuario)) req.input('PacienteId', sql.Int, Number(usuario.id));
    }, `
      SELECT TOP 1
        c.Id,
        c.PacienteId,
        c.FisioterapeutaId,
        c.EspecialidadeId,
        LTRIM(RTRIM(ISNULL(c.Status, N''))) AS Status,
        LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))) AS StatusPagamento,
        ISNULL(c.ValorConsulta, 0) AS ValorConsulta,
        ISNULL(c.IsentoTaxaServico, 0) AS IsentoTaxaServico,
        ISNULL(c.IsentoIntermediacao, 0) AS IsentoIntermediacao
      FROM dbo.Consultas c
      WHERE c.Id = @ConsultaId${wherePaciente};
    `);

    const row = base?.recordset?.[0];
    if (!row) throw new HttpError(404, 'Consulta não encontrada ou sem permissão.');

    const pacienteId = Number(row.PacienteId) || null;
    const fisioterapeutaId = Number(row.FisioterapeutaId ?? 0) || null;
    const especialidadeId = Number(row.EspecialidadeId ?? 0) || null;

    const status = String(row.Status || '');
    const statusPagamento = String(row.StatusPagamento || '');

    const valorConsulta = Number(row.ValorConsulta ?? 0) || 0;

    const isentoTaxa = Number(row.IsentoTaxaServico ?? 0) === 1;
    const isentoInter = Number(row.IsentoIntermediacao ?? 0) === 1;
    const isIsento = isentoTaxa && isentoInter;

    // saldo disponível na carteira (créditos)
    let saldoCarteira = 0;
    if (pacienteId) {
      const r = await queryWithContext(usuario, (req) => {
        req.input('PacienteId', sql.Int, pacienteId);
      }, `
        SELECT ISNULL(SUM(cp.Valor), 0) AS Saldo
        FROM dbo.CreditosPacientes cp
        WHERE cp.PacienteId = @PacienteId
          AND LTRIM(RTRIM(ISNULL(cp.Status, N''))) = N'Disponivel'
          AND cp.UsadoEm IS NULL
          AND cp.PacoteId IS NULL
          AND cp.Valor > 0;
      `);

      saldoCarteira = Number(r?.recordset?.[0]?.Saldo ?? 0) || 0;
    }

    //  Existe pacote com crédito disponível para este fisio?
    // Pacotes disponíveis (sessões restantes) para este fisio
    let totalSessoesPacoteDisponiveis = 0;

    if (pacienteId && fisioterapeutaId) {
      const rPacotes = await queryWithContext(usuario, (req) => {
        req.input('PacienteId', sql.Int, pacienteId);
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
        req.input('EspecialidadeId', sql.Int, especialidadeId);
      }, `
        SELECT COUNT(1) AS TotalSessoesDisponiveis
        FROM dbo.CreditosPacientes cp WITH (READCOMMITTEDLOCK)
        INNER JOIN dbo.Pacotes p WITH (READCOMMITTEDLOCK) ON p.Id = cp.PacoteId
        WHERE cp.PacienteId = @PacienteId
          AND p.FisioterapeutaId = @FisioterapeutaId
          AND (
            @EspecialidadeId IS NULL
            OR p.EspecialidadeId IS NULL
            OR p.EspecialidadeId = @EspecialidadeId
          )
          AND LTRIM(RTRIM(ISNULL(cp.Status, N''))) = N'Disponivel'
          AND cp.UsadoEm IS NULL
          AND cp.ConsultaId IS NULL
          AND LTRIM(RTRIM(ISNULL(p.Status, N''))) = N'Ativo';
      `);

      totalSessoesPacoteDisponiveis =
        Number(rPacotes?.recordset?.[0]?.TotalSessoesDisponiveis ?? 0) || 0;
    }

    const podePagarComPacote = totalSessoesPacoteDisponiveis > 0;

    const encerrada = isTerminalStatus(status) || status === 'Paciente Ausente';
    const jaPaga = statusPagamento === 'Pago' || statusPagamento === 'CreditoPaciente';

    const precisaPagamento = valorConsulta > 0 && !jaPaga && !encerrada;

    //  Sumário do contrato/políticas de cancelamento/reembolso (DocumentosLegais)
    // Usa a view dbo.vw_DocumentosLegais_Ativos (Ativo=1) e busca o Tipo específico.
    // Se não existir (ainda não publicado), retornamos null e NÃO quebramos o fluxo.
    let sumarioContrato = null;
    try {
      const rDoc = await queryWithContext(usuario, (req) => {
        req.input('Tipo', sql.NVarChar(80), 'CancelamentoReembolso');
      }, `
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
          FROM dbo.vw_DocumentosLegais_Ativos d
          WHERE d.Tipo = @Tipo;
        END
      `);

      sumarioContrato = rDoc?.recordset?.[0] ?? null;
    } catch (e) {
      // intencionalmente silencioso (não bloqueia a tela de pagamento)
      sumarioContrato = null;
    }

    //  Retorno enxuto (para montar botões na tela de pagamento)
    const opcoes = {
      ConsultaId: consultaId,
      StatusPagamento: statusPagamento,
      ValorConsulta: valorConsulta,
      SaldoCarteira: saldoCarteira,
      PodePagarViaPlataforma: precisaPagamento, // gateway (mesmo se isento, pode optar)
      PodePagarForaPlataforma: precisaPagamento && isIsento,
      PodePagarComCreditos: precisaPagamento && saldoCarteira >= valorConsulta,
      PodePagarComPacote: precisaPagamento && podePagarComPacote,
      PacotesDisponiveis: totalSessoesPacoteDisponiveis,
      SumarioContrato: sumarioContrato
    };

    // Para Paciente, omitimos "consulta" (a tela pode obter via GET /consultas/:id).
    // Importante: se o controller fizer `res.json({ sucesso:true, consulta, opcoes })`,
    // `consulta: undefined` será omitido automaticamente no JSON.
    const consultaOut = isPaciente(usuario) ? undefined : await this.buscarPorId(consultaId, usuario);

    return { consulta: consultaOut, opcoes };
  },


  /**
   * POST /consultas/:id/pagar-fora-plataforma
   * Somente quando há vínculo ativo (isenção). Chama dbo.SP_Consulta_MarcarPagaForaPlataforma.
   */
  async marcarPagaForaPlataforma(id, usuario) {
    const consultaId = assertId(id, 'Id de consulta');

    requireUser(usuario);
    if (!isAdmin(usuario) && !isPaciente(usuario)) throw new HttpError(403, 'Acesso negado.');

    const consulta = await this.buscarPorId(consultaId, usuario);
    if (!consulta) throw new HttpError(404, 'Consulta não encontrada ou sem permissão.');

    const pacienteId = consulta.PacienteId ?? consulta.pacienteId;
    if (!pacienteId) throw new HttpError(400, 'PacienteId não encontrado para esta consulta.');

    const r = await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, consultaId);
      req.input('PacienteId', sql.Int, pacienteId);
    }, `
      EXEC dbo.SP_Consulta_MarcarPagaForaPlataforma
        @ConsultaId = @ConsultaId,
        @PacienteId = @PacienteId;
    `);

    const retorno = r?.recordset?.[0] ?? null;

    // Se o fisio tiver auto-confirmação habilitada, confirma automaticamente após o pagamento.
    await tentarAutoConfirmarConsultaAposPagamento(usuario, consultaId);

    const consultaAtualizada = await this.buscarPorId(consultaId, usuario);
    return { consulta: consultaAtualizada, retorno };
  },

  /**
   * POST /consultas/:id/pagar-com-creditos
   * Paga a consulta usando créditos da carteira livre
   * (dbo.SP_Pagar_ConsultaComCreditoCarteira).
   * Importante: esta SP deve consumir apenas dbo.CreditosPacientes com PacoteId IS NULL.
   */
  async pagarComCreditoCarteira(id, usuario) {
    const consultaId = assertId(id, 'Id de consulta');

    requireUser(usuario);
    if (!isAdmin(usuario) && !isPaciente(usuario)) throw new HttpError(403, 'Acesso negado.');

    const consulta = await this.buscarPorId(consultaId, usuario);
    if (!consulta) throw new HttpError(404, 'Consulta não encontrada ou sem permissão.');

    if (consulta.StatusPagamento === 'Pago') {
      throw new HttpError(400, 'Esta consulta já foi paga.');
    }

    const pacienteId = consulta.PacienteId ?? consulta.pacienteId;
    if (!pacienteId) throw new HttpError(400, 'PacienteId não encontrado para esta consulta.');

    const r = await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, consultaId);
      req.input('PacienteId', sql.Int, pacienteId);
    }, `
      EXEC dbo.SP_Pagar_ConsultaComCreditoCarteira
        @ConsultaId = @ConsultaId,
        @PacienteId = @PacienteId;
    `);

    const retorno = r?.recordsets?.[0]?.[0] ?? r?.recordset?.[0] ?? null;
    const creditosUsados = r?.recordsets?.[1] ?? [];

    // Se o fisio tiver auto-confirmação habilitada, confirma automaticamente após o pagamento.
    await tentarAutoConfirmarConsultaAposPagamento(usuario, consultaId);

    const consultaAtualizada = await this.buscarPorId(consultaId, usuario);

    return { consulta: consultaAtualizada, retorno, creditosUsados };
  },

  /**
   * POST /consultas/:id/pagar-com-pacote (PACIENTE)
   * Body opcional: { PacoteId?: number }
   *
   * Usa SP: dbo.SP_Consulta_PagarComPacote
   */
  async pagarComPacote(id, dados, usuario) {
    const consultaId = assertId(id, 'id');
    requireUser(usuario);

    if (!isPaciente(usuario) && !isAdmin(usuario)) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const consulta = await this.buscarPorId(consultaId, usuario);
    if (!consulta) throw new HttpError(404, 'Consulta não encontrada.');

    const pacienteId = consulta.PacienteId ?? consulta.pacienteId;
    if (!pacienteId) throw new HttpError(400, 'PacienteId inválido na consulta.');

    const pacoteIdRaw = dados?.PacoteId ?? dados?.pacoteId ?? null;
    const pacoteId =
      pacoteIdRaw === null || pacoteIdRaw === undefined || pacoteIdRaw === ''
        ? null
        : Number(pacoteIdRaw);

    if (pacoteId !== null && (!Number.isInteger(pacoteId) || pacoteId <= 0)) {
      throw new HttpError(400, 'PacoteId inválido.');
    }

    const pacoteDisponivelId = await selecionarPacoteDisponivelParaConsulta({
      pacienteId: Number(pacienteId),
      fisioterapeutaId: Number(consulta.FisioterapeutaId ?? consulta.fisioterapeutaId),
      especialidadeId: Number(consulta.EspecialidadeId ?? 0) || null,
      pacoteId
    }, usuario);

    if (!pacoteDisponivelId) {
      throw new HttpError(400, 'Nenhum pacote ativo disponível para esta especialidade.');
    }

    const r = await queryWithContext(
      usuario,
      (req) => {
        req.input('ConsultaId', sql.Int, consultaId);
        req.input('PacienteId', sql.Int, Number(pacienteId));
        req.input('PacoteId', sql.Int, pacoteDisponivelId);
      },
      `
        EXEC dbo.SP_Consulta_PagarComPacote
          @ConsultaId = @ConsultaId,
          @PacienteId = @PacienteId,
          @PacoteId   = @PacoteId;
      `
    );

    const retorno = r?.recordsets?.[0]?.[0] ?? r?.recordset?.[0] ?? null;

    // Mantém o comportamento do pagar com créditos: tenta confirmar automaticamente se aplicável.
    await tentarAutoConfirmarConsultaAposPagamento(usuario, consultaId);

    const consultaAtualizada = await this.buscarPorId(consultaId, usuario);

    return { consulta: consultaAtualizada, retorno };
  },
  

/**
 * GET /consultas/:id/token  (PACIENTE)
 * Retorna TokenValidacao + TokenGeradoEm + TokenExpiraEm
 */
async obterTokenValidacaoConsulta(id, usuario) {
  const consultaId = assertId(id, 'Id de consulta');

  requireUser(usuario);
  if (!isPaciente(usuario) && !isAdmin(usuario)) throw new HttpError(403, 'Acesso negado.');

  const consulta = await this.buscarPorId(consultaId, usuario);
  if (!consulta) throw new HttpError(404, 'Consulta não encontrada ou sem permissão.');

  const st = String(consulta.Status || '');
  if (st !== STATUS.CONFIRMADA && st !== STATUS.CONCLUIDA) {
    throw new HttpError(409, `Token só está disponível em ${STATUS.CONFIRMADA}/${STATUS.CONCLUIDA}. Status atual: ${consulta.Status}`);
  }

  const token = consulta.TokenValidacao ?? consulta.tokenValidacao ?? null;
  let geradoEmRaw = consulta.TokenGeradoEm ?? consulta.tokenGeradoEm ?? null;
  let checkinRaw = consulta.CheckinHora ?? consulta.checkinHora ?? consulta.DataCheckin ?? consulta.dataCheckin ?? null;
  const tentativasInvalidas = Number(consulta.TentativasInvalidasToken ?? 0);
  const maxTentativas = Number(consulta.MaxTentativasToken ?? 3) || 3;
  const limiteTentativasAtingido =
    Boolean(consulta.LimiteTentativasTokenAtingido) ||
    tentativasInvalidas >= maxTentativas;

  const carregarTemposBrutos = async () => {
    const rawToken = await queryWithContext(usuario, (req) => {
      req.input('ConsultaId', sql.Int, consultaId);
    }, `
      SELECT TOP 1
        CONVERT(varchar(23), TokenGeradoEm, 121) AS TokenGeradoEm,
        CONVERT(varchar(23), CheckinHora, 121) AS CheckinHora,
        CONVERT(varchar(23), DataCheckin, 121) AS DataCheckin
      FROM dbo.Consultas
      WHERE Id = @ConsultaId;
    `);

    const row = rawToken?.recordset?.[0] ?? null;
    if (!row) return;
    geradoEmRaw = row.TokenGeradoEm ?? geradoEmRaw;
    checkinRaw = row.CheckinHora ?? row.DataCheckin ?? checkinRaw;
  };

  if (token && !geradoEmRaw) {
    await carregarTemposBrutos();
  }

  if (!token || !geradoEmRaw) {
    return {
      TokenValidacao: null,
      TokenGeradoEm: null,
      TokenExpiraEm: null,
      TentativasInvalidasToken: tentativasInvalidas,
      MaxTentativasToken: maxTentativas,
      LimiteTentativasTokenAtingido: limiteTentativasAtingido
    };
  }

  let geradoParts = extractSqlLocalDateTimeParts(geradoEmRaw);
  let expiraParts = getTokenExpirationParts({
    TokenGeradoEm: geradoEmRaw,
    CheckinHora: checkinRaw,
    DataCheckin: checkinRaw,
  });

  if ((!geradoParts || !expiraParts) && token) {
    await carregarTemposBrutos();
    geradoParts = extractSqlLocalDateTimeParts(geradoEmRaw);
    expiraParts = getTokenExpirationParts({
      TokenGeradoEm: geradoEmRaw,
      CheckinHora: checkinRaw,
      DataCheckin: checkinRaw,
    });
  }

  if (!geradoParts || !expiraParts) {
    return {
      TokenValidacao: null,
      TokenGeradoEm: null,
      TokenExpiraEm: null,
      TentativasInvalidasToken: tentativasInvalidas,
      MaxTentativasToken: maxTentativas,
      LimiteTentativasTokenAtingido: limiteTentativasAtingido
    };
  }
  const expirado =
    localDateTimePartsToNaiveTimestamp(expiraParts) <=
    localDateTimePartsToNaiveTimestamp(getNowInAppTimeZoneParts());

  return {
    TokenValidacao: token,
    TokenGeradoEm: formatSqlLocalDateTime(geradoParts),
    TokenExpiraEm: formatSqlLocalDateTime(expiraParts),
    Expirado: expirado,
    TentativasInvalidasToken: tentativasInvalidas,
    MaxTentativasToken: maxTentativas,
    LimiteTentativasTokenAtingido: limiteTentativasAtingido
  };
},

/**
 * POST /consultas/:id/gerar-token (ADMIN)
 * Chama dbo.SP_GerarTokenValidacaoConsulta (idempotente).
 */
async gerarTokenValidacaoConsulta(id, usuario, { minutosExpiracao = TOKEN_EXPIRACAO_MIN } = {}) {
  const consultaId = assertId(id, 'Id de consulta');

  requireUser(usuario);
  if (!isAdmin(usuario)) throw new HttpError(403, 'Acesso negado.');

  const consulta = await this.buscarPorId(consultaId, usuario);
  if (!consulta) throw new HttpError(404, 'Consulta não encontrada.');

  const pacienteId = Number(consulta.PacienteId);
  if (!Number.isFinite(pacienteId) || pacienteId <= 0) {
    throw new HttpError(400, 'Consulta inválida (PacienteId ausente).');
  }

  const r = await queryWithContext(usuario, (req) => {
    req.input('ConsultaId', sql.Int, consultaId);
    req.input('PacienteId', sql.Int, pacienteId);
    req.input('MinutosExpiracao', sql.Int, Number(minutosExpiracao) || TOKEN_EXPIRACAO_MIN);
  }, `
    EXEC dbo.SP_GerarTokenValidacaoConsulta @ConsultaId, @PacienteId, @MinutosExpiracao;
  `);

  return r?.recordset?.[0] ?? null;
},

/**
 * POST /consultas/:id/reenviar-token (PACIENTE | FISIOTERAPEUTA)
 * Regenera o token atual e reinicia a contagem de tentativas inválidas.
 */
async reenviarTokenValidacaoConsulta(id, usuario, { minutosExpiracao = TOKEN_EXPIRACAO_MIN } = {}) {
  const consultaId = assertId(id, 'Id de consulta');

  requireUser(usuario);
  if (!isPaciente(usuario) && !isFisio(usuario) && !isAdmin(usuario)) {
    throw new HttpError(403, 'Acesso negado.');
  }

  const consulta = await this.buscarPorId(consultaId, usuario);
  if (!consulta) throw new HttpError(404, 'Consulta não encontrada ou sem permissão.');

  if (String(consulta.Status || '') !== STATUS.CONFIRMADA) {
    throw new HttpError(
      409,
      `Novo token só pode ser gerado quando a consulta está em ${STATUS.CONFIRMADA}. Status atual: ${consulta.Status}`
    );
  }

  if (consulta.ConfirmacaoAtendimento) {
    throw new HttpError(409, 'A consulta já teve o atendimento confirmado.');
  }

  if (!consulta.CheckinHora && !consulta.DataCheckin) {
    throw new HttpError(
      409,
      'O novo código só pode ser gerado após o check-in do fisioterapeuta.'
    );
  }

  const janelaOriginalParts = getTokenExpirationParts({
    TokenGeradoEm: consulta.CheckinHora ?? consulta.DataCheckin,
    CheckinHora: consulta.CheckinHora ?? consulta.DataCheckin,
    DataCheckin: consulta.DataCheckin,
  });
  if (
    janelaOriginalParts &&
    localDateTimePartsToNaiveTimestamp(getNowInAppTimeZoneParts()) >=
      localDateTimePartsToNaiveTimestamp(janelaOriginalParts)
  ) {
    throw new HttpError(
      409,
      'A janela original de validação do código já foi encerrada.'
    );
  }

  const pacienteId = Number(consulta.PacienteId);
  if (!Number.isFinite(pacienteId) || pacienteId <= 0) {
    throw new HttpError(400, 'Consulta inválida (PacienteId ausente).');
  }

  await queryWithContext(usuario, (req) => {
    req.input('ConsultaId', sql.Int, consultaId);
    req.input('PacienteId', sql.Int, pacienteId);
    req.input('MinutosExpiracao', sql.Int, Number(minutosExpiracao) || TOKEN_EXPIRACAO_MIN);
  }, `
    EXEC dbo.SP_GerarTokenValidacaoConsulta @ConsultaId, @PacienteId, @MinutosExpiracao;
  `);

  await queryWithContext(usuario, (req) => {
    req.input('ConsultaId', sql.Int, consultaId);
  }, `
    UPDATE va
       SET va.Token = c.TokenValidacao,
           va.Validado = 0,
           va.DataValidacao = NULL,
           va.TentativasInvalidas = 0,
           va.UltimaTentativaInvalidaEm = NULL
    FROM dbo.ValidacoesAtendimento va
    INNER JOIN dbo.Consultas c
      ON c.Id = va.ConsultaId
    WHERE va.ConsultaId = @ConsultaId;
  `);

  const usuarioTipoLog = isPaciente(usuario)
    ? 'Paciente'
    : isFisio(usuario)
      ? 'Fisioterapeuta'
      : isAdmin(usuario)
        ? 'Admin'
        : String(usuario?.tipo || '');

  await queryWithContext(usuario, (req) => {
    req.input('ConsultaId', sql.Int, consultaId);
    req.input('UsuarioTipo', sql.NVarChar(40), usuarioTipoLog || null);
    req.input('UsuarioId', sql.Int, Number(usuario?.id) || null);
    req.input(
      'Descricao',
      sql.NVarChar(800),
      'Novo código de validação gerado e tentativas inválidas reiniciadas.'
    );
  }, `
    IF OBJECT_ID('dbo.ConsultasLogs', 'U') IS NOT NULL
    BEGIN
      INSERT INTO dbo.ConsultasLogs
        (ConsultaId, Evento, Descricao, Latitude, Longitude, UsuarioTipo, UsuarioId)
      SELECT
        c.Id,
        N'TokenRegenerado',
        @Descricao,
        c.CheckinLatitude,
        c.CheckinLongitude,
        @UsuarioTipo,
        @UsuarioId
      FROM dbo.Consultas c
      WHERE c.Id = @ConsultaId;
    END
  `);

  const consultaAtualizada = await this.buscarPorId(consultaId, usuario);
  const token = consultaAtualizada?.TokenValidacao ?? consultaAtualizada?.tokenValidacao ?? null;
  const geradoEm = consultaAtualizada?.TokenGeradoEm ?? consultaAtualizada?.tokenGeradoEm ?? null;
  const tentativasInvalidas = Number(consultaAtualizada?.TentativasInvalidasToken ?? 0);
  const maxTentativas = Number(consultaAtualizada?.MaxTentativasToken ?? 3) || 3;
  const limiteTentativasAtingido =
    Boolean(consultaAtualizada?.LimiteTentativasTokenAtingido) ||
    tentativasInvalidas >= maxTentativas;

  let retorno = {
    TokenValidacao: null,
    TokenGeradoEm: null,
    TokenExpiraEm: null,
    Expirado: false,
    TentativasInvalidasToken: tentativasInvalidas,
    MaxTentativasToken: maxTentativas,
    LimiteTentativasTokenAtingido: limiteTentativasAtingido
  };
  if (token && geradoEm) {
    const geradoParts = extractSqlLocalDateTimeParts(geradoEm);
    const expiraParts = getTokenExpirationParts(consultaAtualizada);
    if (geradoParts && expiraParts) {
      retorno = {
        TokenValidacao: token,
        TokenGeradoEm: formatSqlLocalDateTime(geradoParts),
        TokenExpiraEm: formatSqlLocalDateTime(expiraParts),
        Expirado:
          localDateTimePartsToNaiveTimestamp(expiraParts) <=
          localDateTimePartsToNaiveTimestamp(getNowInAppTimeZoneParts()),
        TentativasInvalidasToken: tentativasInvalidas,
        MaxTentativasToken: maxTentativas,
        LimiteTentativasTokenAtingido: limiteTentativasAtingido
      };
    }
  }

  return {
    ...(retorno ?? {}),
    Mensagem: 'Novo código gerado com sucesso.'
  };
},

/**
 * POST /consultas/:id/validar-token (FISIOTERAPEUTA)
 * Chama dbo.SP_ValidarTokenConsulta (trigger conclui/encerra a consulta).
 */
async validarTokenConsulta(id, body, usuario) {
  const consultaId = assertId(id, 'Id de consulta');

  requireUser(usuario);
  if (!isAdmin(usuario) && !isFisio(usuario)) throw new HttpError(403, 'Acesso negado.');

  const existente = await this.buscarPorId(consultaId, usuario);
  if (!existente) throw new HttpError(404, 'Consulta não encontrada ou sem permissão.');

  const st = String(existente.Status || '');
  if (st !== STATUS.CONFIRMADA) {
    throw new HttpError(409, `Token só pode ser validado quando a consulta está em ${STATUS.CONFIRMADA}. Status atual: ${existente.Status}`);
  }

  const token = normalizeText(
    body?.token ?? body?.TokenValidacao ?? body?.tokenValidacao ?? body?.Token ?? null,
    16
  );
  if (!token) throw new HttpError(400, 'Token é obrigatório.');

  const fisioId = Number(existente.FisioterapeutaId);
  if (!Number.isFinite(fisioId) || fisioId <= 0) {
    throw new HttpError(400, 'Consulta inválida (FisioterapeutaId ausente).');
  }

  if (isFisio(usuario) && Number(usuario.id) !== fisioId) {
    throw new HttpError(403, 'Acesso negado.');
  }

  const janelaOriginalParts = getTokenExpirationParts({
    TokenGeradoEm: existente.CheckinHora ?? existente.DataCheckin,
    CheckinHora: existente.CheckinHora ?? existente.DataCheckin,
    DataCheckin: existente.DataCheckin,
  });
  if (
    janelaOriginalParts &&
    localDateTimePartsToNaiveTimestamp(getNowInAppTimeZoneParts()) >=
      localDateTimePartsToNaiveTimestamp(janelaOriginalParts)
  ) {
    throw new HttpError(409, 'A janela de validação do token já foi encerrada.');
  }

  const r = await queryWithContext(usuario, (req) => {
    req.input('ConsultaId', sql.Int, consultaId);
    req.input('FisioterapeutaId', sql.Int, fisioId);
    req.input('Token', sql.NVarChar(16), token);
  }, `
    EXEC dbo.SP_ValidarTokenConsulta @ConsultaId, @FisioterapeutaId, @Token;
  `);

  const consultaAtualizada = await this.buscarPorId(consultaId, usuario);

  return {
    resultado: r?.recordset?.[0] ?? null,
    consulta: consultaAtualizada ?? null,
  };
},

};

export default consultasService;
