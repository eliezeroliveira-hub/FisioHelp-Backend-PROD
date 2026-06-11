//  services/disputasService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { reconciliarCreditoPacoteDisponivelPorConsulta } from './_reconciliarCreditoPacoteDisponivel.js';
import reembolsosGatewayFilaService from './reembolsosGatewayFilaService.js';
import { HttpError } from '../utils/httpError.js';

const STATUS_FINAIS = ['ProcedentePaciente', 'ProcedenteFisio', 'Cancelada'];
const STATUS_FILTRO_VALIDOS = new Set([
  'Aberta',
  'EmAnalise',
  'Resolvida',
  'Resolvidas',
  'ProcedentePaciente',
  'ProcedenteFisio',
  'Cancelada'
]);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function normalizeLimitOffset(limitRaw, offsetRaw) {
  const limitNum = Number(limitRaw);
  const offsetNum = Number(offsetRaw);

  return {
    limit: Number.isInteger(limitNum) && limitNum > 0 ? Math.min(limitNum, 100) : 20,
    offset: Number.isInteger(offsetNum) && offsetNum >= 0 ? offsetNum : 0,
  };
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

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw
    .replace(/Z$/i, '')
    .replace(/([+-]\d{2}:\d{2})$/, '')
    .replace(' ', 'T');

  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,7}))?/
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

function formatSqlLocalDateTime(value) {
  const parts = extractSqlLocalDateTimeParts(value);
  if (!parts) return null;

  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}.${pad3(parts.millisecond)}`;
}

function mapDisputaRow(row) {
  if (!row) return row;

  const abertaEm = formatSqlLocalDateTime(row.AbertaEm ?? row.DisputaAbertaEm);
  const emAnaliseEm = formatSqlLocalDateTime(row.EmAnaliseEm);
  const resolvidaEm = formatSqlLocalDateTime(row.ResolvidaEm ?? row.DisputaResolvidaEm);

  return {
    ...row,
    DataConsulta: formatSqlLocalDateTime(row.DataConsulta),
    AbertaEm: abertaEm,
    DisputaAbertaEm: row.DisputaAbertaEm !== undefined ? abertaEm : row.DisputaAbertaEm,
    EmAnaliseEm: emAnaliseEm,
    ResolvidaEm: resolvidaEm,
    DisputaResolvidaEm: row.DisputaResolvidaEm !== undefined ? resolvidaEm : row.DisputaResolvidaEm,
  };
}

function mapConsultaEvidenciaRow(row) {
  if (!row) return row;

  return {
    ...row,
    DataConsulta: formatSqlLocalDateTime(row.DataConsulta),
    CheckinHora: formatSqlLocalDateTime(row.CheckinHora),
    DisputaAbertaEm: formatSqlLocalDateTime(row.DisputaAbertaEm),
    DisputaResolvidaEm: formatSqlLocalDateTime(row.DisputaResolvidaEm),
    DataTransacao: formatSqlLocalDateTime(row.DataTransacao),
    DataPrevistaRepasse: formatSqlLocalDateTime(row.DataPrevistaRepasse),
    DataValidacaoAtendimento: formatSqlLocalDateTime(row.DataValidacaoAtendimento),
  };
}

function mapConsultaLogRow(row) {
  if (!row) return row;

  return {
    ...row,
    DataHora: formatSqlLocalDateTime(row.DataHora),
  };
}

function requireUser(usuario) {
  if (!usuario?.id || !usuario?.tipo) {
    throw new HttpError(401, 'Não autenticado.');
  }
}

function requireAdmin(usuario) {
  requireUser(usuario);
  if (String(usuario.tipo).toLowerCase() !== 'admin') {
    throw new HttpError(403, 'Acesso negado: apenas Admin.');
  }
}

const disputasService = {
  // -------------------------------------------------------------------
  //  Listar disputas (Admin: todas com filtros | Paciente: apenas as suas)
  // -------------------------------------------------------------------
  async listarDisputas(usuario, filtros = {}) {
    requireUser(usuario);

    const tipo = String(usuario.tipo || '').toLowerCase();
    const isAdmin = tipo === 'admin';
    const isPaciente = tipo === 'paciente';
    const isFisio = tipo === 'fisioterapeuta';

    if (!isAdmin && !isPaciente && !isFisio) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const status = filtros?.status == null ? null : String(filtros.status).trim();
    const busca = filtros?.busca == null ? null : String(filtros.busca).trim();
    const { consultaId, fisioterapeutaId } = filtros;
    const pacienteId = isPaciente
      ? Number(usuario.id)
      : (filtros.pacienteId ?? null);
    const paginado = filtros?.paginado === true;
    const { limit, offset } = normalizeLimitOffset(filtros?.limit, filtros?.offset);
    const buscaLike = busca ? `%${busca}%` : null;
    const statusAgrupadoResolvidas = status === 'Resolvida' || status === 'Resolvidas';

    if (status && !STATUS_FILTRO_VALIDOS.has(status)) {
      throw new HttpError(400, 'Status inválido.');
    }

    let query = `
      SELECT
        vw.*,
        d.OpcaoReembolso AS OpcaoReembolsoDisputa,
        d.EmAnaliseEm AS EmAnaliseEm
        ${paginado ? ', COUNT(*) OVER() AS Total' : ''}
      FROM dbo.vw_DisputasConsultas vw
      LEFT JOIN dbo.DisputasConsultas d ON d.Id = vw.DisputaId
      WHERE 1 = 1
    `;

    if (statusAgrupadoResolvidas) {
      query += `
        AND vw.StatusDisputa IN (
          N'Resolvida',
          N'ProcedentePaciente',
          N'ProcedenteFisio'
        )
      `;
    } else if (status) {
      query += ` AND vw.StatusDisputa = @Status`;
    }
    if (consultaId) query += ` AND vw.ConsultaId = @ConsultaId`;
    if (fisioterapeutaId && (isAdmin || isFisio)) query += ` AND vw.FisioterapeutaId = @FisioterapeutaId`;
    if (pacienteId) query += ` AND vw.PacienteId = @PacienteId`;
    if (buscaLike) {
      query += `
        AND (
          CONVERT(NVARCHAR(20), vw.DisputaId) LIKE @Busca
          OR CONVERT(NVARCHAR(20), vw.ConsultaId) LIKE @Busca
          OR ISNULL(vw.StatusConsulta, N'') LIKE @Busca
          OR ISNULL(vw.NomePaciente, N'') LIKE @Busca
          OR ISNULL(vw.NomeFisioterapeuta, N'') LIKE @Busca
          OR ISNULL(vw.StatusDisputa, N'') LIKE @Busca
        )
      `;
    }

    query += `
      ORDER BY
        CASE
          WHEN vw.StatusDisputa IN ('Aberta', 'EmAnalise') THEN 0
          ELSE 1
        END,
        vw.AbertaEm ASC
    `;

    if (paginado) {
      query += `
        OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `;
    } else {
      query += ';';
    }


    // inputs/filters devem ser setados no MESMO request do batch do queryWithContext
    const buildInputs = (request) => {
      if (status && !statusAgrupadoResolvidas) request.input('Status', sql.NVarChar(50), status);
      if (buscaLike) request.input('Busca', sql.NVarChar(200), buscaLike);
      if (consultaId) request.input('ConsultaId', sql.Int, Number(consultaId));
      if (fisioterapeutaId && (isAdmin || isFisio)) request.input('FisioterapeutaId', sql.Int, Number(fisioterapeutaId));
      if (pacienteId) request.input('PacienteId', sql.Int, Number(pacienteId));
      if (paginado) {
        request.input('Limit', sql.Int, limit);
        request.input('Offset', sql.Int, offset);
      }
    };
    
    const result = await queryWithContext(usuario, buildInputs, query);
    const rows = result?.recordset ?? [];
    const itens = rows.map((row) => {
      const { Total: _ignoredTotal, ...rest } = row;
      return mapDisputaRow(rest);
    });

    if (paginado) {
      return {
        itens,
        total: Number(rows[0]?.Total ?? 0),
      };
    }

    return itens;
  },

  // -------------------------------------------------------------------
  //  Evidências / histórico da consulta (logs)
  // -------------------------------------------------------------------
  async obterEvidenciasConsulta(usuario, consultaId) {

    if (!consultaId) throw new HttpError(400, 'ConsultaId é obrigatório.');
    requireAdmin(usuario);

    const result = await queryWithContext(
      usuario,
      (req) => req.input('ConsultaId', sql.Int, consultaId),
        `
      -- 1) Resumo da consulta (1 linha)
      SELECT TOP (1)
        ConsultaId,
        StatusConsulta,
        DataConsulta,
        ValorConsulta,
        ConfirmacaoAtendimento,
        CheckinHora,
        PacienteId,
        NomePaciente,
        EmailPaciente,
        FisioterapeutaId,
        NomeFisioterapeuta,
        EmailFisioterapeuta,
        DisputaId,
        StatusDisputa,
        MotivoDisputa,
        DisputaAbertaEm,
        DisputaResolvidaEm,
        ObservacoesDisputa,
        TransacaoId,
        StatusTransacao,
        ValorTransacao,
        DataTransacao,
        RepasseId,
        StatusRepasse,
        ValorRepasse,
        DataPrevistaRepasse,
        TotalDisputasPaciente,
        DisputasPacienteProcedentes,
        TotalDisputasFisio,
        DisputasFisioPerdeu,
        ValidacaoId,
        TokenValidacao,
        Validado,
        DataValidacaoAtendimento,
        (SELECT TOP (1) c.EvidenciaCheckin
         FROM dbo.Consultas c WITH (NOLOCK)
         WHERE c.Id = @ConsultaId) AS EvidenciaCheckin
      FROM dbo.vw_ConsultasLogs
      WHERE ConsultaId = @ConsultaId
      ORDER BY DataHora ASC;

      -- 2) Logs (enxuto)
      SELECT
        Id,
        ConsultaId,
        Evento,
        Descricao,
        Latitude,
        Longitude,
        DataHora,
        UsuarioTipo,
        UsuarioId,
        NomeUsuarioLog
      FROM dbo.vw_ConsultasLogs
      WHERE ConsultaId = @ConsultaId
      ORDER BY DataHora ASC;
    `
    );

    const consulta = mapConsultaEvidenciaRow(result?.recordsets?.[0]?.[0] ?? null);
    const logs = (result?.recordsets?.[1] ?? []).map(mapConsultaLogRow);

    return { consultaId: Number(consultaId), consulta, logs };
  },

  // -------------------------------------------------------------------
  // Paciente abre disputa (SP_AbrirDisputa)
  // -------------------------------------------------------------------
 async abrirDisputa(usuario, consultaId, pacienteId, motivo, opcaoReembolso = null) {
  const horas = 24;

 const opcao = (opcaoReembolso == null)
  ? null
  : (`${opcaoReembolso}`.trim() === '' ? null : `${opcaoReembolso}`.trim());

// Normaliza (aceita "Crédito"/"credito"/"REEMBOLSO"...)
const normalizarOpcaoReembolso = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const semAcento = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const up = semAcento.toUpperCase();
  if (up === 'CREDITO') return 'Credito';
  if (up === 'REEMBOLSO') return 'Reembolso';
  return null;
};
const opcaoNorm = normalizarOpcaoReembolso(opcao);

if (!consultaId || !pacienteId || !motivo) {
  throw new HttpError(400, 'ConsultaId, PacienteId e motivo são obrigatórios para abrir disputa.');
}
requireUser(usuario);

//  Mini-guard: amarra regras da SP_ResolverDisputa
const tipo = String(usuario?.tipo || '').toLowerCase();

// Paciente: exige opcaoReembolso
if (tipo === 'paciente' && !opcaoNorm) {
  throw new HttpError(400, 'OpcaoReembolso é obrigatória (use "Credito" ou "Reembolso").');
}

// Verifica se há pagamento pela plataforma e se a consulta está paga (Pago / CreditoPaciente / Transacao Pago)
const chk = await queryWithContext(
  usuario,
  (req) => {
    req.input('ConsultaId', sql.Int, Number(consultaId));
    req.input('PacienteId', sql.Int, Number(pacienteId));
  },
  `
    SELECT TOP (1)
      ISNULL(c.PagamentoViaPlataforma, 0) AS PagamentoViaPlataforma,
      LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))) AS StatusPagamento,
      CASE WHEN EXISTS (
        SELECT 1
        FROM dbo.Transacoes t
        WHERE t.ConsultaId = c.Id
          AND t.PacienteId = @PacienteId
          AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago'
      ) THEN 1 ELSE 0 END AS TemTransacaoPaga
      ,
      CASE WHEN EXISTS (
        SELECT 1
        FROM dbo.CreditosPacientes cp
        WHERE cp.ConsultaId = c.Id
          AND cp.PacienteId = @PacienteId
          AND cp.PacoteId IS NOT NULL
      ) THEN 1 ELSE 0 END AS PagoComPacote,
      (
        SELECT TOP (1) LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N'')))
        FROM dbo.Transacoes t
        WHERE t.ConsultaId = c.Id
          AND t.PacienteId = @PacienteId
          AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago'
        ORDER BY t.Id DESC
      ) AS MetodoPagamentoTransacao
    FROM dbo.Consultas c
    WHERE c.Id = @ConsultaId
      AND c.PacienteId = @PacienteId;
  `
);

const row = chk?.recordset?.[0];
if (!row) {
  throw new HttpError(404, 'Consulta não encontrada para este paciente.');
}

const pagamentoViaPlataforma = Number(row.PagamentoViaPlataforma) === 1;
const statusPagamento = String(row.StatusPagamento || '').trim();
const temTransacaoPaga = Number(row.TemTransacaoPaga) === 1;
const metodoPagamentoTransacao = String(row.MetodoPagamentoTransacao || '').trim();
const pagoComPacote =
  Number(row.PagoComPacote) === 1 ||
  metodoPagamentoTransacao === 'Pacote';

const pagoCredito = statusPagamento === 'CreditoPaciente';
const pagoDinheiro = statusPagamento === 'Pago';
const pago = pagoCredito || pagoDinheiro || temTransacaoPaga;

// Regra: fora da plataforma -> não abre disputa (não há o que estornar)
if (!pagamentoViaPlataforma) {
  throw new HttpError(400, 'Pagamento fora da plataforma. Disputa com estorno não disponível.');
}

// Regra: consulta não paga -> não há reembolso/crédito a aplicar
if (!pago) {
  throw new HttpError(400, 'Consulta não foi paga. Não há reembolso/crédito a aplicar.');
}

if (opcaoNorm === 'Reembolso' && pagoComPacote) {
  throw new HttpError(
    400,
    'Consulta paga com pacote: a opção disponível é "Credito" (estorno da sessão no pacote), não "Reembolso".'
  );
}

// Regra: Reembolso em dinheiro só se existir Transacoes.Status="Pago"
// (e também bloqueia quando foi pago com crédito/carteira)
if (
  opcaoNorm === 'Reembolso' &&
  (pagoCredito || !temTransacaoPaga || metodoPagamentoTransacao === 'CreditoCarteira')
) {
  throw new HttpError(400, 'Reembolso em dinheiro indisponível para esta consulta. Selecione "Credito".');
}

const r = await queryWithContext(
  usuario,
  (req) => {
    req.input('ConsultaId', sql.Int, Number(consultaId));
    req.input('PacienteId', sql.Int, Number(pacienteId));
    req.input('Motivo', sql.NVarChar(500), motivo);

    // Novos campos
    req.input('HorasContestacao', sql.Int, Number.isFinite(horas) ? horas : 24);
    req.input('OpcaoReembolso', sql.NVarChar(20), opcaoNorm);
  },
  `
    EXEC dbo.SP_AbrirDisputa
      @ConsultaId = @ConsultaId,
      @PacienteId = @PacienteId,
      @Motivo = @Motivo,
      @HorasContestacao = @HorasContestacao,
      @OpcaoReembolso = @OpcaoReembolso;
  `
);


  // Retorna o payload da SP (quando existir), mantendo compatibilidade.
  return r?.recordset?.[0] ?? { sucesso: true, mensagem: 'Disputa aberta com sucesso.' };
},


  // -------------------------------------------------------------------
  // Admin marca disputa como "Em análise"
  // -------------------------------------------------------------------
  async marcarEmAnalise(usuario, disputaId, observacoes = null) {
    if (!disputaId) throw new HttpError(400, 'DisputaId é obrigatório.');
    requireUser(usuario);

    const result = await queryWithContext(
      usuario,
      (req) => {
        req.input('Id', sql.Int, disputaId);
        req.input('Obs', sql.NVarChar(2000), observacoes || null);
      },
      `
        DECLARE @Saida TABLE (
          Id INT,
          Status NVARCHAR(30),
          EmAnaliseEm DATETIME
        );

        UPDATE dbo.DisputasConsultas
        SET
          Status      = N'EmAnalise',
          EmAnaliseEm = COALESCE(EmAnaliseEm, SYSDATETIME()),
          Observacoes = @Obs
        OUTPUT inserted.Id, inserted.Status, inserted.EmAnaliseEm
          INTO @Saida (Id, Status, EmAnaliseEm)
        WHERE Id = @Id;

        SELECT TOP (1)
          Id,
          Status,
          EmAnaliseEm
        FROM @Saida;
      `
    );

    if (result.rowsAffected[0] === 0) {
      throw new HttpError(404, 'Disputa não encontrada ou não atualizada.');
    }

    const row = result.recordset?.[0] ?? null;

    return {
      sucesso: true,
      mensagem: 'Disputa marcada como Em análise.',
      disputaId: row?.Id ?? disputaId,
      status: row?.Status ?? 'EmAnalise',
      emAnaliseEm: formatSqlLocalDateTime(row?.EmAnaliseEm ?? null),
    };
  },

  // -------------------------------------------------------------------
  //  Resolução final da disputa (SP_ResolverDisputa)
  // -------------------------------------------------------------------
  async resolverDisputa(usuario, args = {}) {
    const {
      disputaId,
      novoStatus,
      observacoes,
      usuarioId,
      usuarioTipo = 'Admin'
    } = args || {};

    if (!disputaId || !novoStatus) {
      throw new HttpError(400, 'DisputaId e novoStatus são obrigatórios.');
    }

    if (!STATUS_FINAIS.includes(novoStatus)) {
      throw new HttpError(400, 'Status inválido. Use "ProcedentePaciente", "ProcedenteFisio" ou "Cancelada".');
    }

    requireUser(usuario);

    const motivoClawback = String(
      observacoes ?? `Clawback por disputa procedente ao paciente. DisputaId=${disputaId}`
    )
      .trim()
      .slice(0, 500);

    await queryWithContext(
      usuario,
      (req) => {
        req.input('DisputaId', sql.Int, disputaId);
        req.input('NovoStatus', sql.NVarChar(50), novoStatus);
        req.input('Observacoes', sql.NVarChar(2000), observacoes || null);
        req.input('UsuarioId', sql.Int, usuarioId || null);
        req.input('UsuarioTipo', sql.NVarChar(50), usuarioTipo);
        req.input('MotivoClawback', sql.NVarChar(500), motivoClawback);
      },
      `
        SET XACT_ABORT ON;
        BEGIN TRY
          BEGIN TRAN;

          DECLARE @ConsultaId INT = NULL;
          DECLARE @DisputaStatus NVARCHAR(50) = @NovoStatus;
          DECLARE @StatusChamado NVARCHAR(60) = CASE WHEN @NovoStatus = N'Cancelada' THEN N'Cancelado' ELSE N'Concluido' END;

          IF @NovoStatus = N'ProcedentePaciente'
          BEGIN
            SELECT TOP (1) @ConsultaId = ConsultaId
            FROM dbo.DisputasConsultas
            WHERE Id = @DisputaId;

            IF @ConsultaId IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM dbo.Repasses r
                INNER JOIN dbo.Transacoes t ON t.Id = r.TransacaoId
                WHERE t.ConsultaId = @ConsultaId
                  AND LTRIM(RTRIM(ISNULL(r.Status, N''))) = N'Pago'
                  AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago'
              )
            BEGIN
              EXEC dbo.SP_RegistrarClawbackSeRepassePago
                @ConsultaId = @ConsultaId,
                @DisputaId  = @DisputaId,
                @Motivo     = @MotivoClawback;
            END
          END

          EXEC dbo.SP_ResolverDisputa
            @DisputaId   = @DisputaId,
            @NovoStatus  = @NovoStatus,
            @Observacoes = @Observacoes,
            @UsuarioId   = @UsuarioId,
            @UsuarioTipo = @UsuarioTipo;

          UPDATE fc
          SET
            Status = @StatusChamado,
            DataConclusao = CASE
              WHEN @StatusChamado IN (N'Concluido', N'Cancelado') THEN COALESCE(fc.DataConclusao, SYSDATETIME())
              ELSE NULL
            END,
            UltimaAtualizacao = SYSDATETIME(),
            ObservacoesInternas = LEFT(
              CONCAT(
                COALESCE(NULLIF(fc.ObservacoesInternas, N''), N''),
                CASE WHEN fc.ObservacoesInternas IS NULL OR fc.ObservacoesInternas = N'' THEN N'' ELSE N' | ' END,
                N'DisputaResolvida=', @DisputaStatus
              ),
              500
            )
          FROM dbo.FaleConoscoChamados fc
          INNER JOIN dbo.DisputasConsultas d ON d.ConsultaId = fc.ConsultaId
          WHERE d.Id = @DisputaId
            AND fc.ObservacoesInternas LIKE N'%Origem=SP_AbrirDisputa_FaleConosco%'
            AND fc.ObservacoesInternas LIKE N'%DisputaId=' + CONVERT(NVARCHAR(20), @DisputaId) + N'%';

          COMMIT;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          THROW;
        END CATCH
      `
    );

    if (novoStatus === 'ProcedentePaciente') {
      const reembolsoInfo = await queryWithContext(
        usuario,
        (req) => {
          req.input('DisputaId', sql.Int, disputaId);
        },
        `
          SELECT TOP (1)
            d.ConsultaId,
            d.OpcaoReembolso,
            t.Id AS TransacaoId
          FROM dbo.DisputasConsultas d
          LEFT JOIN dbo.Transacoes t
            ON t.ConsultaId = d.ConsultaId
           AND t.PacienteId = d.PacienteId
           AND LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N''))) NOT IN (N'Pacote', N'CreditoCarteira')
           AND LTRIM(RTRIM(ISNULL(t.Status, N''))) IN (N'Pago', N'Reembolsado')
          WHERE d.Id = @DisputaId
          ORDER BY t.Id DESC;
        `
      );

      const reembolsoRow = reembolsoInfo?.recordset?.[0] ?? null;
      const opcaoReembolso = String(reembolsoRow?.OpcaoReembolso ?? '').trim();
      const transacaoId = Number(reembolsoRow?.TransacaoId ?? 0) || null;

      if (opcaoReembolso === 'Reembolso' && transacaoId) {
        await reembolsosGatewayFilaService.enfileirarReembolso(
          {
            transacaoId,
            consultaId: reembolsoRow?.ConsultaId ?? null,
            disputaId,
            origem: 'Disputa',
            motivo: `Disputa procedente ao paciente #${disputaId}`
          },
          usuario
        );
      }

      const consultaInfo = await queryWithContext(
        usuario,
        (req) => {
          req.input('DisputaId', sql.Int, disputaId);
        },
        `
          SELECT TOP (1) ConsultaId
          FROM dbo.DisputasConsultas
          WHERE Id = @DisputaId;
        `
      );

      const consultaId = Number(consultaInfo?.recordset?.[0]?.ConsultaId ?? 0) || null;
      if (consultaId) {
        await reconciliarCreditoPacoteDisponivelPorConsulta(consultaId, usuario);
      }
    }

    return { sucesso: true, mensagem: `Disputa ${disputaId} resolvida como ${novoStatus}.` };
  }
};

export default disputasService;
