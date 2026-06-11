// 📁 services/carteiraService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

function asTipo(u) {
  return String(u?.tipo || '').toLowerCase();
}
function isAdmin(u) {
  return asTipo(u) === 'admin';
}
function isFisio(u) {
  return asTipo(u) === 'fisioterapeuta';
}
function requireAuth(usuario) {
  if (!usuario?.id || !usuario?.tipo) throw new HttpError(401, 'Não autenticado.');
}
function assertId(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} inválido.`);
  return n;
}

function parseDateOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function currentMesReferencia() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

function normalizeMesReferencia(v) {
  const s = String(v ?? '').trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : currentMesReferencia();
}

function monthNameFromMesReferencia(mesReferencia) {
  const mm = String(mesReferencia ?? '').slice(5, 7);
  switch (mm) {
    case '01': return 'Janeiro';
    case '02': return 'Fevereiro';
    case '03': return 'Março';
    case '04': return 'Abril';
    case '05': return 'Maio';
    case '06': return 'Junho';
    case '07': return 'Julho';
    case '08': return 'Agosto';
    case '09': return 'Setembro';
    case '10': return 'Outubro';
    case '11': return 'Novembro';
    case '12': return 'Dezembro';
    default: return null;
  }
}

function toInt(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Number(n) : 0;
}

function toPercent(numerator, denominator) {
  const den = Number(denominator ?? 0);
  if (!Number.isFinite(den) || den <= 0) return 0;
  const num = Number(numerator ?? 0);
  if (!Number.isFinite(num)) return 0;
  return Number(((num * 100) / den).toFixed(2));
}

const REPASSE_STATUS = new Set(['pendente', 'pago', 'atrasado']);
function normalizeRepasseStatusOrThrow(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (!REPASSE_STATUS.has(s)) {
    throw new HttpError(400, 'Status inválido. Use: Pendente, Pago, Atrasado.');
  }
  if (s === 'pendente') return 'Pendente';
  if (s === 'pago') return 'Pago';
  if (s === 'atrasado') return 'Atrasado';
  return null;
}

const LOTE_REPASSE_STATUS = new Set([
  'processando',
  'enviadogateway',
  'aguardandoconfirmacao',
  'concluido',
  'falhatemporaria',
  'falhadefinitiva',
  'cancelado',
]);
function normalizeLoteRepasseStatusOrThrow(v) {
  if (v === undefined || v === null || v === '') return null;
  const raw = String(v).trim();
  const key = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!LOTE_REPASSE_STATUS.has(key)) {
    throw new HttpError(400, 'Status de lote inválido.');
  }
  const map = {
    processando: 'Processando',
    enviadogateway: 'EnviadoGateway',
    aguardandoconfirmacao: 'AguardandoConfirmacao',
    concluido: 'Concluido',
    falhatemporaria: 'FalhaTemporaria',
    falhadefinitiva: 'FalhaDefinitiva',
    cancelado: 'Cancelado',
  };
  return map[key];
}

function parseBool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return ['1', 'true', 'sim', 'yes', 'on'].includes(s);
}

const carteiraService = {
  /**
   * 📊 Carteira > Dashboard
   * Fontes:
   * - analytics.vw_FisioDashboard (financeiro/reputação + mês de referência)
   * - dbo.Consultas (métricas mensais e históricas de consultas)
   */
  async obterDashboard(usuario, { fisioterapeutaId = null, mesReferencia = null } = {}) {
    requireAuth(usuario);

    if (!isAdmin(usuario) && !isFisio(usuario)) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const fid = isAdmin(usuario)
      ? assertId(fisioterapeutaId ?? usuario.id, 'FisioterapeutaId')
      : assertId(usuario.id, 'Usuário');
    const mesRefFiltro = mesReferencia ? normalizeMesReferencia(mesReferencia) : null;

    const dashboardResult = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fid);
      req.input('MesReferencia', sql.Char(7), mesRefFiltro);
    }, `
      SELECT TOP 1
        FisioterapeutaId,
        FisioterapeutaNome,
        TotalRecebido,
        ValorPendente,
        ValorPago,
        MediaNota,
        TotalAvaliacoes,
        MesReferencia,
        NomeMes,
        ReceitaLiquida
      FROM analytics.vw_FisioDashboard
      WHERE FisioterapeutaId = @FisioterapeutaId
        AND (@MesReferencia IS NULL OR MesReferencia = @MesReferencia)
      ORDER BY MesReferencia DESC;
    `);

    const base = dashboardResult.recordset?.[0] || null;
    const mesReferenciaNormalizada = normalizeMesReferencia(mesRefFiltro ?? base?.MesReferencia);
    const nomeMes = base?.NomeMes ?? monthNameFromMesReferencia(mesReferenciaNormalizada);

    const consultasResult = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fid);
      req.input('MesReferencia', sql.Char(7), mesReferenciaNormalizada);
    }, `
      ;WITH Base AS (
        SELECT
          c.DataHora,
          UPPER(LTRIM(RTRIM(ISNULL(c.Status, N'')))) COLLATE Latin1_General_CI_AI AS StatusNorm
        FROM dbo.Consultas c
        WHERE c.FisioterapeutaId = @FisioterapeutaId
      ),
      Ref AS (
        SELECT
          CASE
            WHEN TRY_CONVERT(INT, LEFT(@MesReferencia, 4)) BETWEEN 2000 AND 2100
              THEN TRY_CONVERT(INT, LEFT(@MesReferencia, 4))
            ELSE YEAR(GETDATE())
          END AS AnoRef,
          CASE
            WHEN TRY_CONVERT(INT, RIGHT(@MesReferencia, 2)) BETWEEN 1 AND 12
              THEN TRY_CONVERT(INT, RIGHT(@MesReferencia, 2))
            ELSE MONTH(GETDATE())
          END AS MesRef
      ),
      RangeMes AS (
        SELECT DATEFROMPARTS(AnoRef, MesRef, 1) AS InicioMes
        FROM Ref
      )
      SELECT
        COUNT_BIG(1) AS TotalConsultasGeral,
        ISNULL(SUM(CASE WHEN b.StatusNorm IN (N'CONCLUIDA', N'CONCLUIDO') THEN 1 ELSE 0 END), 0) AS ConsultasConcluidasGeral,
        ISNULL(SUM(CASE WHEN b.StatusNorm = N'CANCELADA' THEN 1 ELSE 0 END), 0) AS ConsultasCanceladasGeral,
        ISNULL(SUM(CASE WHEN b.StatusNorm = N'CONFIRMADA' THEN 1 ELSE 0 END), 0) AS ConsultasConfirmadasGeral,
        ISNULL(SUM(CASE WHEN b.StatusNorm = N'PACIENTE AUSENTE' THEN 1 ELSE 0 END), 0) AS PacienteAusenteGeral,
        ISNULL(SUM(CASE WHEN b.StatusNorm = N'FISIOTERAPEUTA AUSENTE' THEN 1 ELSE 0 END), 0) AS FisioterapeutaAusenteGeral,

        ISNULL(SUM(CASE WHEN b.DataHora >= r.InicioMes AND b.DataHora < DATEADD(MONTH, 1, r.InicioMes) THEN 1 ELSE 0 END), 0) AS TotalConsultasMes,
        ISNULL(SUM(CASE WHEN b.DataHora >= r.InicioMes AND b.DataHora < DATEADD(MONTH, 1, r.InicioMes) AND b.StatusNorm IN (N'CONCLUIDA', N'CONCLUIDO') THEN 1 ELSE 0 END), 0) AS ConsultasConcluidasMes,
        ISNULL(SUM(CASE WHEN b.DataHora >= r.InicioMes AND b.DataHora < DATEADD(MONTH, 1, r.InicioMes) AND b.StatusNorm = N'CANCELADA' THEN 1 ELSE 0 END), 0) AS ConsultasCanceladasMes,
        ISNULL(SUM(CASE WHEN b.DataHora >= r.InicioMes AND b.DataHora < DATEADD(MONTH, 1, r.InicioMes) AND b.StatusNorm = N'CONFIRMADA' THEN 1 ELSE 0 END), 0) AS ConsultasConfirmadasMes,
        ISNULL(SUM(CASE WHEN b.DataHora >= r.InicioMes AND b.DataHora < DATEADD(MONTH, 1, r.InicioMes) AND b.StatusNorm = N'PACIENTE AUSENTE' THEN 1 ELSE 0 END), 0) AS PacienteAusenteMes,
        ISNULL(SUM(CASE WHEN b.DataHora >= r.InicioMes AND b.DataHora < DATEADD(MONTH, 1, r.InicioMes) AND b.StatusNorm = N'FISIOTERAPEUTA AUSENTE' THEN 1 ELSE 0 END), 0) AS FisioterapeutaAusenteMes
      FROM Base b
      CROSS JOIN RangeMes r;
    `);

    const c = consultasResult.recordset?.[0] || {};

    const totalConsultasMes = toInt(c.TotalConsultasMes);
    const consultasConcluidasMes = toInt(c.ConsultasConcluidasMes);
    const consultasCanceladasMes = toInt(c.ConsultasCanceladasMes);
    const consultasConfirmadasMes = toInt(c.ConsultasConfirmadasMes);
    const pacienteAusenteMes = toInt(c.PacienteAusenteMes);
    const fisioterapeutaAusenteMes = toInt(c.FisioterapeutaAusenteMes);

    const totalConsultasGeral = toInt(c.TotalConsultasGeral);
    const consultasConcluidasGeral = toInt(c.ConsultasConcluidasGeral);
    const consultasCanceladasGeral = toInt(c.ConsultasCanceladasGeral);
    const consultasConfirmadasGeral = toInt(c.ConsultasConfirmadasGeral);
    const pacienteAusenteGeral = toInt(c.PacienteAusenteGeral);
    const fisioterapeutaAusenteGeral = toInt(c.FisioterapeutaAusenteGeral);

    return {
      FisioterapeutaId: base?.FisioterapeutaId ?? fid,
      FisioterapeutaNome: base?.FisioterapeutaNome ?? null,

      // Métricas exibidas no card (alinhadas ao mês de referência)
      TotalConsultas: totalConsultasMes,
      ConsultasConcluidas: consultasConcluidasMes,
      ConsultasCanceladas: consultasCanceladasMes,
      ConsultasConfirmadas: consultasConfirmadasMes,
      PercentualCancelamento: toPercent(consultasCanceladasMes, totalConsultasMes),

      // Financeiro/reputação seguem a mesma fonte atual do dashboard
      TotalRecebido: Number(base?.TotalRecebido ?? 0),
      ValorPendente: Number(base?.ValorPendente ?? 0),
      ValorPago: Number(base?.ValorPago ?? 0),
      MediaNota: base?.MediaNota ?? null,
      TotalAvaliacoes: toInt(base?.TotalAvaliacoes),
      MesReferencia: mesReferenciaNormalizada,
      NomeMes: nomeMes,
      ReceitaLiquida: Number(base?.ReceitaLiquida ?? 0),

      // Bloco futuro para API de histórico geral
      HistoricoGeralConsultas: {
        TotalConsultas: totalConsultasGeral,
        ConsultasConcluidas: consultasConcluidasGeral,
        ConsultasCanceladas: consultasCanceladasGeral,
        ConsultasConfirmadas: consultasConfirmadasGeral,
        PacienteAusente: pacienteAusenteGeral,
        FisioterapeutaAusente: fisioterapeutaAusenteGeral,
        PercentualCancelamento: toPercent(consultasCanceladasGeral, totalConsultasGeral),
        PercentualPacienteAusente: toPercent(pacienteAusenteGeral, totalConsultasGeral),
        PercentualFisioterapeutaAusente: toPercent(fisioterapeutaAusenteGeral, totalConsultasGeral),
      },

      // Bloco explícito mensal (mesma semântica dos campos do card)
      ResumoMensalConsultas: {
        MesReferencia: mesReferenciaNormalizada,
        TotalConsultas: totalConsultasMes,
        ConsultasConcluidas: consultasConcluidasMes,
        ConsultasCanceladas: consultasCanceladasMes,
        ConsultasConfirmadas: consultasConfirmadasMes,
        PacienteAusente: pacienteAusenteMes,
        FisioterapeutaAusente: fisioterapeutaAusenteMes,
        PercentualCancelamento: toPercent(consultasCanceladasMes, totalConsultasMes),
        PercentualPacienteAusente: toPercent(pacienteAusenteMes, totalConsultasMes),
        PercentualFisioterapeutaAusente: toPercent(fisioterapeutaAusenteMes, totalConsultasMes),
      },
    };
  },

  /**
   * 🧾 Carteira > Resumo financeiro
   * Fonte ÚNICA: analytics.vw_FisioFinanceiroResumo
   * (sem expor __Fonte no JSON)
   */
  async obterResumoFinanceiro(usuario, { fisioterapeutaId = null } = {}) {
    requireAuth(usuario);

    if (!isAdmin(usuario) && !isFisio(usuario)) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const fid = isAdmin(usuario)
      ? assertId(fisioterapeutaId ?? usuario.id, 'FisioterapeutaId')
      : assertId(usuario.id, 'Usuário');

    const result = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fid);
    }, `
      SELECT TOP 1
        FisioterapeutaId,
        FisioterapeutaNome,
        MesReferencia,
        NomeMes,
        TotalRecebido,
        ValorPendente,
        ValorPago,
        TotalRepasses,
        UltimoPagamento,
        AtualizadoEm
      FROM analytics.vw_FisioFinanceiroResumo
      WHERE FisioterapeutaId = @FisioterapeutaId;
    `);

    return result.recordset?.[0] || null;
  },

  /**
   * 🧾 Carteira > Resumo financeiro geral (acumulado histórico)
   * Fonte ÚNICA: analytics.vw_FisioFinanceiroResumoGeral
   */
  async obterResumoFinanceiroGeral(usuario, { fisioterapeutaId = null } = {}) {
    requireAuth(usuario);

    if (!isAdmin(usuario) && !isFisio(usuario)) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const fid = isAdmin(usuario)
      ? assertId(fisioterapeutaId ?? usuario.id, 'FisioterapeutaId')
      : assertId(usuario.id, 'Usuário');

    const result = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fid);
    }, `
      SELECT TOP 1
        FisioterapeutaId,
        FisioterapeutaNome,
        TotalRecebido,
        ValorPendente,
        ValorPago,
        TotalRepasses,
        UltimoPagamento,
        AtualizadoEm
      FROM analytics.vw_FisioFinanceiroResumoGeral
      WHERE FisioterapeutaId = @FisioterapeutaId;
    `);

    return result.recordset?.[0] || null;
  },

  /**
   * 💸 Carteira > Repasses
   * Fonte: dbo.Repasses
   *
   * Blindagem:
   * - Fisio SEMPRE usa usuario.id, ignora fisioterapeutaId vindo do cliente
   * - Admin pode consultar qualquer fisio
   */
  async listarRepasses(usuario, { fisioterapeutaId = null, status = null, de = null, ate = null, limit = 200, offset = 0 } = {}) {
    requireAuth(usuario);

    if (!isAdmin(usuario) && !isFisio(usuario)) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const fid = isFisio(usuario)
      ? assertId(usuario.id, 'Usuário')
      : assertId(fisioterapeutaId ?? usuario.id, 'FisioterapeutaId');

    const st = normalizeRepasseStatusOrThrow(status);
    const dtDe = parseDateOrNull(de);
    const dtAte = parseDateOrNull(ate);

    const lim = Number(limit);
    const off = Number(offset);
    const pageLimit = Number.isFinite(lim) && lim > 0 && lim <= 500 ? Math.floor(lim) : 200;
    const pageOffset = Number.isFinite(off) && off >= 0 ? Math.floor(off) : 0;

    const result = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fid);
      req.input('Status', sql.NVarChar(40), st);
      req.input('De', sql.DateTime2, dtDe);
      req.input('Ate', sql.DateTime2, dtAte);
      req.input('Limit', sql.Int, pageLimit);
      req.input('Offset', sql.Int, pageOffset);
    }, `
      ;WITH Base AS (
        SELECT
          Id,
          FisioterapeutaId,
          TransacaoId,
          ValorLiquido,
          DataPrevista,
          DataPagamento,
          Status
        FROM dbo.Repasses
        WHERE FisioterapeutaId = @FisioterapeutaId
          AND ValorLiquido > 0
          AND (@Status IS NULL OR Status = @Status)
          AND (@De  IS NULL OR ISNULL(DataPagamento, DataPrevista) >= @De)
          AND (@Ate IS NULL OR ISNULL(DataPagamento, DataPrevista) <= @Ate)
      )
      SELECT COUNT(1) AS Total FROM Base;

      ;WITH Base AS (
        SELECT
          Id,
          FisioterapeutaId,
          TransacaoId,
          ValorLiquido,
          DataPrevista,
          DataPagamento,
          Status
        FROM dbo.Repasses
        WHERE FisioterapeutaId = @FisioterapeutaId
          AND ValorLiquido > 0
          AND (@Status IS NULL OR Status = @Status)
          AND (@De  IS NULL OR ISNULL(DataPagamento, DataPrevista) >= @De)
          AND (@Ate IS NULL OR ISNULL(DataPagamento, DataPrevista) <= @Ate)
      )
      SELECT
        Id,
        FisioterapeutaId,
        TransacaoId,
        ValorLiquido,
        DataPrevista,
        DataPagamento,
        Status
      FROM Base
      ORDER BY ISNULL(DataPagamento, DataPrevista) DESC, Id DESC
      OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
    `);

    return {
      total: result?.recordsets?.[0]?.[0]?.Total ?? 0,
      limit: pageLimit,
      offset: pageOffset,
      itens: result?.recordsets?.[1] || []
    };
  },

  /**
   * 💸 Carteira > Repasses por lote gateway
   * Novo contrato para demonstrativo de repasse:
   * - lotes: totalizadores de transferência, ajustes e tarifa
   * - pendentesSemLote: repasses ainda acumulando para o próximo ciclo
   */
  async listarLotesRepasses(usuario, { fisioterapeutaId = null, status = null, incluirHistorico = false, de = null, ate = null, limit = 100, offset = 0 } = {}) {
    requireAuth(usuario);

    if (!isAdmin(usuario) && !isFisio(usuario)) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const fid = isFisio(usuario)
      ? assertId(usuario.id, 'Usuário')
      : assertId(fisioterapeutaId ?? usuario.id, 'FisioterapeutaId');

    const dtDe = parseDateOrNull(de);
    const dtAte = parseDateOrNull(ate);
    const st = normalizeLoteRepasseStatusOrThrow(status);
    const includeHistorico = parseBool(incluirHistorico);

    const lim = Number(limit);
    const off = Number(offset);
    const pageLimit = Number.isFinite(lim) && lim > 0 && lim <= 300 ? Math.floor(lim) : 100;
    const pageOffset = Number.isFinite(off) && off >= 0 ? Math.floor(off) : 0;

    const result = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fid);
      req.input('De', sql.DateTime2, dtDe);
      req.input('Ate', sql.DateTime2, dtAte);
      req.input('Status', sql.NVarChar(40), st);
      req.input('IncluirHistorico', sql.Bit, includeHistorico ? 1 : 0);
      req.input('Limit', sql.Int, pageLimit);
      req.input('Offset', sql.Int, pageOffset);
    }, `
      SET NOCOUNT ON;

      DECLARE @LotesPagina TABLE (LoteId INT NOT NULL PRIMARY KEY);

      ;WITH Base AS (
        SELECT
          l.Id,
          dr.DataReferencia
        FROM dbo.LotesRepassesGateway l WITH (READCOMMITTEDLOCK)
        CROSS APPLY (
          SELECT COALESCE(l.ConfirmadoEm, l.EnviadoEm, l.CriadoEm) AS DataReferencia
        ) dr
        WHERE l.FisioterapeutaId = @FisioterapeutaId
          AND (@Status IS NULL OR l.Status = @Status)
          AND (
            @Status IS NOT NULL
            OR @IncluirHistorico = 1
            OR l.Status IN (N'Processando', N'EnviadoGateway', N'AguardandoConfirmacao', N'Concluido')
          )
          AND (@De  IS NULL OR dr.DataReferencia >= @De)
          AND (@Ate IS NULL OR dr.DataReferencia <= @Ate)
      )
      SELECT COUNT(1) AS Total FROM Base;

      ;WITH Base AS (
        SELECT
          l.Id,
          dr.DataReferencia
        FROM dbo.LotesRepassesGateway l WITH (READCOMMITTEDLOCK)
        CROSS APPLY (
          SELECT COALESCE(l.ConfirmadoEm, l.EnviadoEm, l.CriadoEm) AS DataReferencia
        ) dr
        WHERE l.FisioterapeutaId = @FisioterapeutaId
          AND (@Status IS NULL OR l.Status = @Status)
          AND (
            @Status IS NOT NULL
            OR @IncluirHistorico = 1
            OR l.Status IN (N'Processando', N'EnviadoGateway', N'AguardandoConfirmacao', N'Concluido')
          )
          AND (@De  IS NULL OR dr.DataReferencia >= @De)
          AND (@Ate IS NULL OR dr.DataReferencia <= @Ate)
      )
      INSERT INTO @LotesPagina (LoteId)
      SELECT Id
      FROM Base
      ORDER BY DataReferencia DESC, Id DESC
      OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;

      SELECT
        l.Id,
        l.FisioterapeutaId,
        l.GatewayProvider,
        l.Status,
        l.MetodoTransferencia,
        l.ValorBrutoRepasses,
        l.ValorAjustesAplicados,
        l.ValorTarifaTransferencia,
        l.TarifaTransferenciaDescricao,
        l.ValorTransferencia,
        l.GatewayTransferId,
        l.GatewayTransferStatus,
        l.GatewayReceiptUrl,
        l.GatewayUltimoEvento,
        l.GatewayErroMensagem,
        l.GatewayTransferFee,
        l.Tentativas,
        l.ProximaTentativaEm,
        l.EnviadoEm,
        l.ConfirmadoEm,
        l.CriadoEm,
        l.AtualizadoEm,
        COALESCE(l.ConfirmadoEm, l.EnviadoEm, l.CriadoEm) AS DataReferencia
      FROM dbo.LotesRepassesGateway l
      JOIN @LotesPagina p ON p.LoteId = l.Id
      ORDER BY COALESCE(l.ConfirmadoEm, l.EnviadoEm, l.CriadoEm) DESC, l.Id DESC;

      SELECT
        i.LoteId,
        i.Id AS ItemId,
        i.RepasseId,
        i.FisioterapeutaId,
        i.TransacaoId,
        t.ConsultaId,
        c.PacienteId,
        c.DataHora AS DataConsulta,
        c.Status AS StatusConsulta,
        i.ValorRepasse,
        i.ValorAjusteAplicado,
        i.ValorTransferidoItem,
        i.StatusItem,
        r.ValorLiquido AS RepasseValorLiquidoAtual,
        r.DataPrevista,
        r.DataPagamento,
        r.Status AS StatusRepasse
      FROM dbo.LoteRepassesGatewayItens i WITH (READCOMMITTEDLOCK)
      JOIN @LotesPagina p ON p.LoteId = i.LoteId
      JOIN dbo.Repasses r WITH (READCOMMITTEDLOCK) ON r.Id = i.RepasseId
      LEFT JOIN dbo.Transacoes t WITH (READCOMMITTEDLOCK) ON t.Id = i.TransacaoId
      LEFT JOIN dbo.Consultas c WITH (READCOMMITTEDLOCK) ON c.Id = t.ConsultaId
      ORDER BY i.LoteId DESC, i.Id ASC;

      ;WITH Pendentes AS (
        SELECT
          r.Id
        FROM dbo.Repasses r WITH (READCOMMITTEDLOCK)
        WHERE r.FisioterapeutaId = @FisioterapeutaId
          AND LTRIM(RTRIM(ISNULL(r.Status, N''))) = N'Pendente'
          AND r.ValorLiquido > 0
          AND (@De  IS NULL OR r.DataPrevista >= @De)
          AND (@Ate IS NULL OR r.DataPrevista <= @Ate)
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.LoteRepassesGatewayItens i WITH (READCOMMITTEDLOCK)
            WHERE i.RepasseId = r.Id
              AND i.StatusItem IN (N'Reservado', N'EnviadoGateway', N'Pago', N'LiquidadoPorAjuste')
          )
      )
      SELECT COUNT(1) AS TotalPendentesSemLote FROM Pendentes;

      SELECT TOP (@Limit)
        r.Id,
        r.FisioterapeutaId,
        r.TransacaoId,
        t.ConsultaId,
        c.PacienteId,
        c.DataHora AS DataConsulta,
        c.Status AS StatusConsulta,
        r.ValorLiquido,
        r.DataPrevista,
        r.DataPagamento,
        r.Status,
        r.GatewayUltimoEvento,
        r.GatewayErroMensagem
      FROM dbo.Repasses r WITH (READCOMMITTEDLOCK)
      LEFT JOIN dbo.Transacoes t WITH (READCOMMITTEDLOCK) ON t.Id = r.TransacaoId
      LEFT JOIN dbo.Consultas c WITH (READCOMMITTEDLOCK) ON c.Id = t.ConsultaId
      WHERE r.FisioterapeutaId = @FisioterapeutaId
        AND LTRIM(RTRIM(ISNULL(r.Status, N''))) = N'Pendente'
        AND r.ValorLiquido > 0
        AND (@De  IS NULL OR r.DataPrevista >= @De)
        AND (@Ate IS NULL OR r.DataPrevista <= @Ate)
        AND NOT EXISTS (
          SELECT 1
          FROM dbo.LoteRepassesGatewayItens i WITH (READCOMMITTEDLOCK)
          WHERE i.RepasseId = r.Id
            AND i.StatusItem IN (N'Reservado', N'EnviadoGateway', N'Pago', N'LiquidadoPorAjuste')
        )
      ORDER BY r.DataPrevista ASC, r.Id ASC;
    `);

    const loteRows = result?.recordsets?.[1] || [];
    const itemRows = result?.recordsets?.[2] || [];
    const lotes = loteRows.map((lote) => ({ ...lote, repasses: [] }));
    const porId = new Map(lotes.map((lote) => [Number(lote.Id), lote]));

    for (const item of itemRows) {
      const lote = porId.get(Number(item.LoteId));
      if (lote) lote.repasses.push(item);
    }

    return {
      total: result?.recordsets?.[0]?.[0]?.Total ?? 0,
      limit: pageLimit,
      offset: pageOffset,
      lotes,
      totalPendentesSemLote: result?.recordsets?.[3]?.[0]?.TotalPendentesSemLote ?? 0,
      pendentesSemLote: result?.recordsets?.[4] || [],
    };
  }
};

export { HttpError };
export default carteiraService;
