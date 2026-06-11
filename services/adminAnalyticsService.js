// 📁 services/adminAnalyticsService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';
// 🔐 Allowlist de views/tables expostas por este service (evita SQL injection via FROM)
const VIEW_ALLOWLIST = new Set([
  'analytics.vw_AtividadePacientesMensal',
  'analytics.vw_ChatModerationAlertas',
  'analytics.vw_ChatModerationResumo',
  'analytics.vw_ChatModerationResumoDiario',
  'analytics.vw_ChatModerationStats',
  'analytics.vw_ChatModerationUsuariosReincidentes',
  'analytics.vw_ConsultasPorEspecialidade',
  'analytics.vw_CrescimentoUsuarios',
  'analytics.vw_FaturamentoMensal',
  'analytics.vw_FaturamentoMensalPersistida',
  'analytics.vw_FisioAssinaturasPremium',
  'analytics.vw_FisioAtendimentosPendentes',
  'analytics.vw_FisioIndicacoesResumo',
  'analytics.vw_FisioPerformanceMensalResumo',
  'analytics.vw_FunnelConsultas',
  'analytics.vw_IndicadoresFinanceirosGlobais',
  'analytics.vw_LogAtualizacaoCache',
  'analytics.vw_LogCacheResumo',
  'analytics.vw_ProjecaoCrescimentoAnual',
  'analytics.vw_ProjecaoCrescimentoMensal',
  'analytics.vw_RepassesPendentes',
  'analytics.vw_ResumoFinanceiroAnual',
  'analytics.vw_ResumoFinanceiroMensal',
  'analytics.vw_RetencaoPacientes',
  'analytics.vw_SinaisBypass',
  'analytics.vw_TopFisioterapeutas',
  'analytics.vw_DashboardGerencialCompleto',
  'analytics.vw_PipelineFinanceiro',
  'dbo.vw_AssinaturaPremiumAtual',
  'dbo.vw_AuditoriaMensagens',
  'dbo.vw_ConsultasStatus',
  'dbo.vw_Despesas',
  'dbo.vw_DocumentosFisioterapeutas',
  'dbo.vw_EspecialidadesAtivas',
  'dbo.vw_FisioPontuacaoHistorico',
  'dbo.vw_JobsStatus',
  'dbo.vw_LogExecucoesJobs',
  'dbo.vw_LogsFinanceiros',
  'dbo.vw_Transacoes'
]);

const SAFE_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_LIMIT = 1000;

function assertId(value, label = 'Id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label} inválido.`);
  return n;
}

function toBit(value, label = 'Ativa') {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 1 || value === 0) return value;
  if (value === '1' || value === '0') return Number(value);
  throw new HttpError(400, `${label} inválida (use 1/0 ou true/false).`);
}

function assertValorDespesa(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Valor inválido.');
  return Number(n.toFixed(2));
}

function assertPeriodoAnoMes(value, label = 'Periodo') {
  if (value == null || value === '') return null;
  const periodo = String(value).trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) {
    throw new HttpError(400, `${label} inválido. Use o formato YYYY-MM.`);
  }
  return periodo;
}

function assertTipoDespesa(tipo) {
  const tiposPermitidos = new Set(['Fixa', 'Variavel']);
  if (!tiposPermitidos.has(tipo)) {
    throw new HttpError(400, 'Tipo inválido. Use apenas: Fixa ou Variavel.');
  }
  return tipo;
}

function normalizeOrderBy(raw) {
  if (!raw) return null;
  const txt = String(raw).trim();
  if (!txt) return null;

  // Aceita: "Campo ASC", "Campo DESC", "Campo", e múltiplos separados por vírgula.
  const parts = txt.split(',').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;

  const normalized = [];
  for (const part of parts) {
    const tokens = part.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens.length > 2) return null;

    const col = tokens[0];
    const dir = (tokens[1] || 'ASC').toUpperCase();

    if (!SAFE_FIELD_RE.test(col)) return null;
    if (dir !== 'ASC' && dir !== 'DESC') return null;

    normalized.push(`${col} ${dir}`);
  }

  return normalized.join(', ');
}

function coerceFilterValue(raw) {
  if (raw === undefined || raw === null) return null;
  if (raw instanceof Date) return raw;

  const t = typeof raw;
  if (t === 'number' || t === 'boolean') return raw;

  if (t === 'string') {
    const s = raw.trim();
    if (s === '') return null;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (/^-?\d+\.\d+$/.test(s)) return Number(s);
    if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
    if (/^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?)?$/.test(s)) {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return s;
  }

  throw new HttpError(400, 'Filtro inválido. Tipos permitidos: texto, número, booleano e data.');
}

function inferSqlType(v) {
  if (v instanceof Date) return sql.DateTime2;
  if (typeof v === 'boolean') return sql.Bit;
  if (typeof v === 'number') return Number.isInteger(v) ? sql.Int : sql.Decimal(18, 4);
  return sql.NVarChar(sql.MAX);
}


const adminAnalyticsService = {

  /**
   * Consulta dinâmica com filtros opcionais + limite automático + ORDER BY opcional
   * Exemplo:
   *   fetchView("analytics.vw_FaturamentoMensal", { ano: 2025, mes: 10, limit: 50, orderBy: "Mes DESC" })
   */
  async fetchView(usuario, viewName, filtros = {}) {
    if (String(usuario?.tipo || '').toLowerCase() !== 'admin') {
      throw new HttpError(403, 'Acesso negado.');
    }

    if (!VIEW_ALLOWLIST.has(viewName)) {
      throw new HttpError(403, `View não permitida: ${viewName}`);
    }

    const whereClauses = [];
    const filtrosObj = { ...(filtros || {}) };

    // 🔹 Limite padrão = 200
    let limit = 200;
    if (Object.prototype.hasOwnProperty.call(filtrosObj, 'limit')) {
      const parsed = Number(filtrosObj.limit);
      if (!Number.isNaN(parsed) && parsed > 0) limit = Math.min(parsed, MAX_LIMIT);
      delete filtrosObj.limit;
    }

    // 🔹 ORDER BY opcional (sanitizado)
    let orderBy = '';
    if (Object.prototype.hasOwnProperty.call(filtrosObj, 'orderBy')) {
      const ob = normalizeOrderBy(filtrosObj.orderBy);
      if (ob) orderBy = `ORDER BY ${ob}`;
      delete filtrosObj.orderBy;
    }

    // 🔹 Monta WHERE dinâmico (somente campos seguros)
    const params = [];
    for (const [campo, valor] of Object.entries(filtrosObj)) {
      if (valor === undefined || valor === null || valor === '') continue;
      if (!SAFE_FIELD_RE.test(campo)) continue;

      const v = coerceFilterValue(valor);
      if (v === null) continue;
      params.push([campo, v]);
      whereClauses.push(`${campo} = @${campo}`);
    }

    const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const query = `
      SELECT TOP (${limit}) *
      FROM ${viewName}
      ${whereSQL}
      ${orderBy};
    `;

    const result = await queryWithContext(
      usuario,
      (request) => {
        for (const [k, v] of params) {
          request.input(k, inferSqlType(v), v);
        }
        return request;
      },
      query
    );

    return result.recordset;
  },
  /* --------------------------------------------------------------------
     📊 FINANCEIRO GERAL
  -------------------------------------------------------------------- */
  dashboardGerencial(usuario, f)          { return this.fetchView(usuario, 'analytics.vw_DashboardGerencialCompleto', f); },
  resumoFinanceiroMensal(usuario, f)      { return this.fetchView(usuario, 'analytics.vw_ResumoFinanceiroMensal', f); },
  resumoFinanceiroAnual(usuario, f)       { return this.fetchView(usuario, 'analytics.vw_ResumoFinanceiroAnual', f); },
  faturamentoMensal(usuario, f)           { return this.fetchView(usuario, 'analytics.vw_FaturamentoMensal', f); },
  faturamentoMensalHistorico(usuario, f)  { return this.fetchView(usuario, 'analytics.vw_FaturamentoMensalPersistida', f); },
  indicadoresFinanceiros(usuario, f)      { return this.fetchView(usuario, 'analytics.vw_IndicadoresFinanceirosGlobais', f); },
  pipelineFinanceiro(usuario, f)          { return this.fetchView(usuario, 'analytics.vw_PipelineFinanceiro', f); },
  repassesPendentes(usuario, f)           { return this.fetchView(usuario, 'analytics.vw_RepassesPendentes', f); },

  async analiseOperacional(usuario, filtros) {
    if (String(usuario?.tipo || '').toLowerCase() !== 'admin') {
      throw new HttpError(403, 'Acesso negado.');
    }

    const filtrosObj = filtros || {};
    const periodo = assertPeriodoAnoMes(filtrosObj?.Periodo ?? filtrosObj?.periodo);

    const result = await queryWithContext(
      usuario,
      (request) => request
        .input('Periodo', sql.VarChar(7), periodo),
      `
        DECLARE @PeriodoRef CHAR(7) = COALESCE(
          @Periodo,
          (SELECT TOP (1) Periodo FROM cache.DashboardGerencial ORDER BY Periodo DESC),
          CONVERT(CHAR(7), SYSDATETIME(), 120)
        );
        DECLARE @DtInicio DATE = CONVERT(DATE, CONCAT(@PeriodoRef, '-01'));
        DECLARE @DtFim DATE = DATEADD(MONTH, 1, @DtInicio);

        IF OBJECT_ID('tempdb..#ConsultasPeriodoOperacional') IS NOT NULL DROP TABLE #ConsultasPeriodoOperacional;
        CREATE TABLE #ConsultasPeriodoOperacional
        (
          Id INT NOT NULL,
          PacienteId INT NOT NULL,
          FisioterapeutaId INT NOT NULL,
          DataHora DATETIME NOT NULL,
          Dia DATE NOT NULL,
          DiaSemanaNum INT NOT NULL,
          DiaSemanaNome NVARCHAR(30) NOT NULL
        );

        INSERT INTO #ConsultasPeriodoOperacional
          (Id, PacienteId, FisioterapeutaId, DataHora, Dia, DiaSemanaNum, DiaSemanaNome)
        SELECT
            c.Id,
            c.PacienteId,
            c.FisioterapeutaId,
            c.DataHora,
            Dia = CAST(c.DataHora AS DATE),
            DiaSemanaNum = (DATEDIFF(DAY, CONVERT(DATE, '19000107'), CAST(c.DataHora AS DATE)) % 7) + 1,
            DiaSemanaNome = CASE ((DATEDIFF(DAY, CONVERT(DATE, '19000107'), CAST(c.DataHora AS DATE)) % 7) + 1)
              WHEN 1 THEN N'Domingo'
              WHEN 2 THEN N'Segunda-feira'
              WHEN 3 THEN N'Terça-feira'
              WHEN 4 THEN N'Quarta-feira'
              WHEN 5 THEN N'Quinta-feira'
              WHEN 6 THEN N'Sexta-feira'
              WHEN 7 THEN N'Sábado'
            END
        FROM dbo.Consultas c
        WHERE c.DataHora >= @DtInicio
          AND c.DataHora < @DtFim
          AND LTRIM(RTRIM(ISNULL(c.Status, N''))) IN (N'Concluída', N'Concluida');

        ;WITH FisioterapeutasOperacionais AS (
          SELECT f.Id
          FROM dbo.Fisioterapeutas f
          WHERE ISNULL(f.Ativo, 1) = 1
            AND ISNULL(f.IsBloqueado, 0) = 0
        ),
        FisioPacienteMes AS (
          SELECT
            cp.FisioterapeutaId,
            PacientesUnicos = COUNT(DISTINCT cp.PacienteId),
            Consultas = COUNT_BIG(1)
          FROM #ConsultasPeriodoOperacional cp
          GROUP BY cp.FisioterapeutaId
        ),
        Base AS (
          SELECT
            Periodo = @PeriodoRef,
            ReceitaBruta = CAST(ISNULL(dg.ReceitaBruta, 0) AS DECIMAL(18,2)),
            BreakEvenEstimado = CAST(ISNULL(dg.BreakEvenEstimado, 0) AS DECIMAL(18,2)),
            FisioterapeutasAtivos = (
              SELECT COUNT_BIG(1)
              FROM FisioterapeutasOperacionais f
            ),
            PacientesAtivosCadastrados = (
              SELECT COUNT_BIG(1)
              FROM dbo.Pacientes p
              WHERE ISNULL(p.Ativo, 1) = 1
                AND ISNULL(p.IsBloqueado, 0) = 0
            ),
            PacientesUnicosAtendidos = (
              SELECT COUNT(DISTINCT cp.PacienteId)
              FROM #ConsultasPeriodoOperacional cp
            ),
            TotalConsultasConcluidas = (
              SELECT COUNT_BIG(1)
              FROM #ConsultasPeriodoOperacional cp
            ),
            DiasComAtendimento = (
              SELECT COUNT(DISTINCT cp.Dia)
              FROM #ConsultasPeriodoOperacional cp
            ),
            FisioterapeutasComAtendimento = (
              SELECT COUNT(DISTINCT cp.FisioterapeutaId)
              FROM #ConsultasPeriodoOperacional cp
            ),
            MediaPacientesUnicosPorFisioMes = (
              SELECT CAST(AVG(CAST(fp.PacientesUnicos AS DECIMAL(18,4))) AS DECIMAL(18,4))
              FROM FisioPacienteMes fp
            ),
            MediaConsultasPorFisioMes = (
              SELECT CAST(AVG(CAST(fp.Consultas AS DECIMAL(18,4))) AS DECIMAL(18,4))
              FROM FisioPacienteMes fp
            )
          FROM (SELECT 1 AS x) seed
          OUTER APPLY (
            SELECT TOP (1) ReceitaBruta, BreakEvenEstimado
            FROM cache.DashboardGerencial
            WHERE Periodo = @PeriodoRef
          ) dg
        ),
        CalcSessoes AS (
          SELECT
            b.*,
            SessoesPorPacienteMes = CAST(
              CASE
                WHEN b.PacientesUnicosAtendidos = 0 THEN 0
                ELSE b.TotalConsultasConcluidas / NULLIF(CAST(b.PacientesUnicosAtendidos AS DECIMAL(18,4)), 0)
              END AS DECIMAL(18,2)
            ),
            CapacidadeSessoesPorFisioMes = CAST(96.0 AS DECIMAL(18,2))
          FROM Base b
        ),
        Calc AS (
          SELECT
            cs.*,
            PacientesUnicosNecessariosPorFisio = CAST(
              CASE
                WHEN cs.SessoesPorPacienteMes = 0 THEN NULL
                ELSE cs.CapacidadeSessoesPorFisioMes / NULLIF(cs.SessoesPorPacienteMes, 0)
              END AS DECIMAL(18,2)
            ),
            CapacidadeMensalSessoes = CAST(cs.FisioterapeutasAtivos * cs.CapacidadeSessoesPorFisioMes AS DECIMAL(18,2)),
            DemandaEstimadaSessoes = CAST(cs.PacientesAtivosCadastrados * cs.SessoesPorPacienteMes AS DECIMAL(18,2)),
            SessoesPorSemana = CAST(
              CASE
                WHEN DATEDIFF(DAY, @DtInicio, @DtFim) = 0 THEN 0
                ELSE cs.TotalConsultasConcluidas / NULLIF((DATEDIFF(DAY, @DtInicio, @DtFim) / 7.0), 0)
              END AS DECIMAL(18,2)
            ),
            SessoesPorDiaComAtendimento = CAST(
              CASE
                WHEN cs.DiasComAtendimento = 0 THEN 0
                ELSE cs.TotalConsultasConcluidas / NULLIF(CAST(cs.DiasComAtendimento AS DECIMAL(18,4)), 0)
              END AS DECIMAL(18,2)
            )
          FROM CalcSessoes cs
        )
        SELECT
          Periodo,
          ReceitaBruta,
          BreakEvenEstimado,
          FisioterapeutasAtivos,
          FisioterapeutasComAtendimento,
          PacientesAtivosCadastrados,
          PacientesUnicosAtendidos,
          TotalConsultasConcluidas,
          SessoesPorPacienteMes,
          CapacidadeSessoesPorFisioMes,
          PacientesUnicosNecessariosPorFisio,
          CapacidadeMensalSessoes,
          DemandaEstimadaSessoes,
          OcupacaoCapacidadePct = CAST(
            CASE WHEN CapacidadeMensalSessoes = 0 THEN NULL
                 ELSE (DemandaEstimadaSessoes / NULLIF(CapacidadeMensalSessoes, 0)) * 100.0
            END AS DECIMAL(18,2)
          ),
          MediaPacientesUnicosPorFisioMes = CAST(ISNULL(MediaPacientesUnicosPorFisioMes, 0) AS DECIMAL(18,2)),
          MediaConsultasPorFisioMes = CAST(ISNULL(MediaConsultasPorFisioMes, 0) AS DECIMAL(18,2)),
          SessoesPorDiaComAtendimento,
          SessoesPorSemana,
          AtingimentoMetaFisioPct = CAST(
            CASE WHEN CapacidadeSessoesPorFisioMes = 0 THEN NULL
                 ELSE (CAST(ISNULL(MediaConsultasPorFisioMes, 0) AS DECIMAL(18,4)) / NULLIF(CapacidadeSessoesPorFisioMes, 0)) * 100.0
            END AS DECIMAL(18,2)
          ),
          DiasComAtendimento,
          DiasSemanaAtendimento = ISNULL(STUFF((
            SELECT N', ' + x.DiaSemanaNome
            FROM (
              SELECT DISTINCT cp.DiaSemanaNum, cp.DiaSemanaNome
              FROM #ConsultasPeriodoOperacional cp
            ) x
            ORDER BY x.DiaSemanaNum
            FOR XML PATH(''), TYPE
          ).value('.', 'NVARCHAR(MAX)'), 1, 2, N''), N'—'),
          AcaoSugerida = CASE
            WHEN ReceitaBruta < BreakEvenEstimado THEN N'Aumentar valor da consulta, taxas, plano ou avaliar redução de despesas'
            WHEN DemandaEstimadaSessoes < CapacidadeMensalSessoes THEN N'Aumentar número de pacientes'
            WHEN DemandaEstimadaSessoes > CapacidadeMensalSessoes * 1.5 THEN N'Aumentar número de fisioterapeutas ou ajustar distribuição de pacientes'
            ELSE N'Equilíbrio saudável'
          END,
          CodigoAnalise = CASE
            WHEN ReceitaBruta < BreakEvenEstimado THEN N'RECEITA_ABAIXO_BREAK_EVEN'
            WHEN DemandaEstimadaSessoes < CapacidadeMensalSessoes THEN N'CAPACIDADE_OCIOSA'
            WHEN DemandaEstimadaSessoes > CapacidadeMensalSessoes * 1.5 THEN N'CAPACIDADE_EXCEDIDA'
            ELSE N'EQUILIBRIO_SAUDAVEL'
          END,
          SignificadoPratico = CASE
            WHEN ReceitaBruta < BreakEvenEstimado THEN N'As receitas ainda não cobrem o ponto de equilíbrio estimado do período.'
            WHEN DemandaEstimadaSessoes < CapacidadeMensalSessoes THEN N'A equipe tem capacidade disponível para atender mais pacientes sem ampliar o quadro.'
            WHEN DemandaEstimadaSessoes > CapacidadeMensalSessoes * 1.5 THEN N'A demanda estimada ultrapassa 150% da capacidade operacional mensal.'
            ELSE N'A estrutura está balanceada entre pacientes, fisioterapeutas e custos.'
          END
        FROM Calc;

        SELECT
          DiaSemanaNome,
          DiaSemanaNum,
          Consultas = COUNT_BIG(1),
          PacientesUnicos = COUNT(DISTINCT PacienteId),
          FisioterapeutasUnicos = COUNT(DISTINCT FisioterapeutaId)
        FROM #ConsultasPeriodoOperacional
        GROUP BY DiaSemanaNome, DiaSemanaNum
        ORDER BY DiaSemanaNum;
      `
    );

    return {
      resumo: result.recordsets?.[0]?.[0] ?? null,
      distribuicaoDiasSemana: result.recordsets?.[1] ?? [],
    };
  },

  // 🆕 NOVAS VIEWS — agora usando fetchView, com orderBy padrão:
  async transacoes(usuario, f) {
    if (String(usuario?.tipo || '').toLowerCase() !== 'admin') {
      throw new HttpError(403, 'Acesso negado.');
    }

    const filtros = { ...(f || {}) };

    let limit = 20;
    if (Object.prototype.hasOwnProperty.call(filtros, 'limit')) {
      const parsed = Number(filtros.limit);
      if (!Number.isNaN(parsed) && parsed > 0) limit = Math.min(parsed, MAX_LIMIT);
      delete filtros.limit;
    }

    let offset = 0;
    if (Object.prototype.hasOwnProperty.call(filtros, 'offset')) {
      const parsed = Number(filtros.offset);
      if (!Number.isNaN(parsed) && parsed >= 0) offset = Math.floor(parsed);
      delete filtros.offset;
    }

    const orderBy = normalizeOrderBy(filtros.orderBy) || 'DataCriacao DESC, Id DESC';
    delete filtros.orderBy;

    const busca = String(filtros.busca || '').trim();
    delete filtros.busca;

    const whereClauses = [];
    const params = [];

    if (busca) {
      whereClauses.push(`(
        CONVERT(NVARCHAR(40), Id) LIKE @Busca
        OR CONVERT(NVARCHAR(40), ConsultaId) LIKE @Busca
        OR CONVERT(NVARCHAR(40), PacienteId) LIKE @Busca
        OR CONVERT(NVARCHAR(40), FisioterapeutaId) LIKE @Busca
        OR ISNULL(MetodoPagamento, N'') LIKE @Busca
        OR ISNULL(Status, N'') LIKE @Busca
        OR ISNULL(CodigoTransacao, N'') LIKE @Busca
        OR ISNULL(GatewayCheckoutId, N'') LIKE @Busca
        OR ISNULL(GatewayPaymentId, N'') LIKE @Busca
        OR ISNULL(GatewayPaymentStatus, N'') LIKE @Busca
        OR ISNULL(GatewayRefundStatus, N'') LIKE @Busca
        OR ISNULL(GatewayRefundId, N'') LIKE @Busca
        OR ISNULL(GatewayUltimoEvento, N'') LIKE @Busca
        OR ISNULL(GatewayErroMensagem, N'') LIKE @Busca
      )`);
      params.push(['Busca', `%${busca}%`, sql.NVarChar(sql.MAX)]);
    }

    const allowedFilters = new Set([
      'Id',
      'ConsultaId',
      'PacienteId',
      'FisioterapeutaId',
      'MetodoPagamento',
      'Status',
      'CodigoTransacao',
      'MetodoPagamentoId',
      'GatewayCheckoutId',
      'GatewayPaymentId',
      'GatewayPaymentStatus',
      'GatewayRefundStatus',
      'GatewayRefundId',
      'GatewayUltimoEvento'
    ]);

    for (const [campo, valor] of Object.entries(filtros)) {
      if (!allowedFilters.has(campo) || valor === undefined || valor === null || valor === '') continue;
      const v = coerceFilterValue(valor);
      if (v === null) continue;
      whereClauses.push(`${campo} = @${campo}`);
      params.push([campo, v, inferSqlType(v)]);
    }

    const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const result = await queryWithContext(
      usuario,
      (request) => {
        request.input('Limit', sql.Int, limit);
        request.input('Offset', sql.Int, offset);
        for (const [k, v, type] of params) {
          request.input(k, type, v);
        }
        return request;
      },
      `
        SELECT COUNT_BIG(1) AS Total
        FROM dbo.vw_Transacoes
        ${whereSQL};

        SELECT *
        FROM dbo.vw_Transacoes
        ${whereSQL}
        ORDER BY ${orderBy}
        OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `
    );

    return {
      itens: result.recordsets?.[1] ?? [],
      total: Number(result.recordsets?.[0]?.[0]?.Total ?? 0),
      limit,
      offset
    };
  },

  async logsFinanceiros(usuario, f) {
    if (String(usuario?.tipo || '').toLowerCase() !== 'admin') {
      throw new HttpError(403, 'Acesso negado.');
    }

    const filtros = { ...(f || {}) };

    let limit = 20;
    if (Object.prototype.hasOwnProperty.call(filtros, 'limit')) {
      const parsed = Number(filtros.limit);
      if (!Number.isNaN(parsed) && parsed > 0) limit = Math.min(parsed, MAX_LIMIT);
      delete filtros.limit;
    }

    let offset = 0;
    if (Object.prototype.hasOwnProperty.call(filtros, 'offset')) {
      const parsed = Number(filtros.offset);
      if (!Number.isNaN(parsed) && parsed >= 0) offset = Math.floor(parsed);
      delete filtros.offset;
    }

    const orderBy = normalizeOrderBy(filtros.orderBy) || 'DataAcao DESC, Id DESC';
    delete filtros.orderBy;

    const busca = String(filtros.busca || '').trim();
    delete filtros.busca;

    const whereClauses = [];
    const params = [];

    if (busca) {
      whereClauses.push(`(
        CONVERT(NVARCHAR(40), Id) LIKE @Busca
        OR CONVERT(NVARCHAR(40), TransacaoId) LIKE @Busca
        OR CONVERT(NVARCHAR(40), RepasseId) LIKE @Busca
        OR ISNULL(Usuario, N'') LIKE @Busca
        OR ISNULL(Acao, N'') LIKE @Busca
        OR ISNULL(Observacao, N'') LIKE @Busca
      )`);
      params.push(['Busca', `%${busca}%`, sql.NVarChar(sql.MAX)]);
    }

    const allowedFilters = new Set([
      'Id',
      'TransacaoId',
      'RepasseId',
      'Usuario',
      'Acao'
    ]);

    for (const [campo, valor] of Object.entries(filtros)) {
      if (!allowedFilters.has(campo) || valor === undefined || valor === null || valor === '') continue;
      const v = coerceFilterValue(valor);
      if (v === null) continue;
      whereClauses.push(`${campo} = @${campo}`);
      params.push([campo, v, inferSqlType(v)]);
    }

    const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const result = await queryWithContext(
      usuario,
      (request) => {
        request.input('Limit', sql.Int, limit);
        request.input('Offset', sql.Int, offset);
        for (const [k, v, type] of params) {
          request.input(k, type, v);
        }
        return request;
      },
      `
        SELECT COUNT_BIG(1) AS Total
        FROM dbo.vw_LogsFinanceiros
        ${whereSQL};

        SELECT *
        FROM dbo.vw_LogsFinanceiros
        ${whereSQL}
        ORDER BY ${orderBy}
        OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `
    );

    return {
      itens: result.recordsets?.[1] ?? [],
      total: Number(result.recordsets?.[0]?.[0]?.Total ?? 0),
      limit,
      offset
    };
  },

   /* --------------------------------------------------------------------
      💼 DESPESAS (controle financeiro interno)
  -------------------------------------------------------------------- */
   despesasView(usuario, f) { return this.fetchView(usuario, 'dbo.vw_Despesas', f);},

   async inserirDespesa(usuario, dados) {
      const { Descricao, Valor, Tipo, Ativa = 1 } = dados || {};
      const descricao = String(Descricao || '').trim();
      if (!descricao) throw new HttpError(400, 'Descricao é obrigatória.');
      const valor = assertValorDespesa(Valor);
      const tipo = assertTipoDespesa(Tipo);
      const ativa = toBit(Ativa);
      const criadoPor = assertId(usuario?.id, 'AdminId');

      await queryWithContext(
        usuario,
        (request) => request
          .input('Descricao', sql.NVarChar(300), descricao)
          .input('Valor', sql.Decimal(10, 2), valor)
          .input('Tipo', sql.NVarChar(30), tipo)
          .input('Ativa', sql.Bit, ativa)
          .input('CriadoPor', sql.Int, criadoPor),
        `
        INSERT INTO dbo.Despesas (Descricao, Valor, Tipo, Ativa, DataCriacao, CriadoPor)
        VALUES (@Descricao, @Valor, @Tipo, @Ativa, SYSDATETIME(), @CriadoPor);`
      );

      return { sucesso: true, mensagem: 'Despesa inserida com sucesso.' };
    },

async atualizarDespesa(usuario, id, dados) {
      const despesaId = assertId(id, 'Id');
      const { Descricao, Valor, Tipo, Ativa = 1 } = dados || {};
      const descricao = String(Descricao || '').trim();
      if (!descricao) throw new HttpError(400, 'Descricao é obrigatória.');
      const valor = assertValorDespesa(Valor);
      const tipo = assertTipoDespesa(Tipo);
      const ativa = toBit(Ativa);

      const result = await queryWithContext(
        usuario,
        (request) => request
          .input('Id', sql.Int, despesaId)
          .input('Descricao', sql.NVarChar(300), descricao)
          .input('Valor', sql.Decimal(10, 2), valor)
          .input('Tipo', sql.NVarChar(30), tipo)
          .input('Ativa', sql.Bit, ativa),
        `
        UPDATE dbo.Despesas
        SET 
          Descricao = @Descricao,
          Valor = @Valor,
          Tipo = @Tipo,
          Ativa = @Ativa
        WHERE Id = @Id;

        SELECT @@ROWCOUNT AS LinhasAfetadas;
      `
      );

      if (!result.recordset?.[0]?.LinhasAfetadas) {
        throw new HttpError(404, 'Despesa não encontrada.');
      }

      return { sucesso: true, mensagem: 'Despesa atualizada com sucesso.' };
    },


async excluirDespesa(usuario, id) {
      const despesaId = assertId(id, 'Id');
      const result = await queryWithContext(
        usuario,
        (request) => request.input('Id', sql.Int, despesaId),
        `
      DELETE FROM dbo.Despesas WHERE Id = @Id;
      SELECT @@ROWCOUNT AS LinhasAfetadas;`
      );
    if (!result.recordset?.[0]?.LinhasAfetadas) {
      throw new HttpError(404, 'Despesa não encontrada.');
    }
    return { sucesso: true, mensagem: 'Despesa excluída com sucesso.' };
   },

  /* --------------------------------------------------------------------  /*
     📈 CRESCIMENTO E PROJEÇÕES
  -------------------------------------------------------------------- */
  crescimentoUsuarios(usuario, f)         { return this.fetchView(usuario, 'analytics.vw_CrescimentoUsuarios', f); },
  projecaoMensal(usuario, f)              { return this.fetchView(usuario, 'analytics.vw_ProjecaoCrescimentoMensal', f); },
  async projecaoAnual(usuario, f) {
    if (String(usuario?.tipo || '').toLowerCase() !== 'admin') {
      throw new HttpError(403, 'Acesso negado.');
    }

    const filtros = { ...(f || {}) };

    let limit = 200;
    if (Object.prototype.hasOwnProperty.call(filtros, 'limit')) {
      const parsed = Number(filtros.limit);
      if (!Number.isNaN(parsed) && parsed > 0) limit = Math.min(parsed, MAX_LIMIT);
      delete filtros.limit;
    }

    const orderBy = normalizeOrderBy(filtros.orderBy) || 'Ano DESC';

    const result = await queryWithContext(
      usuario,
      null,
      `
        WITH Mensal AS
        (
          SELECT
            Ano = TRY_CONVERT(INT, LEFT(Periodo, 4)),
            ReceitaBruta = CAST(ISNULL(ReceitaBruta, 0) AS DECIMAL(18,2)),
            DespesasTotais = CAST(ISNULL(DespesasTotais, 0) AS DECIMAL(18,2)),
            CustoGateway = CAST(ISNULL(CustoGateway, 0) AS DECIMAL(18,2)),
            LucroLiquido = CAST(ISNULL(LucroLiquido, 0) AS DECIMAL(18,2)),
            MargemPct = CAST(ISNULL(COALESCE(MargemLiquidaPct, MargemPct), 0) AS DECIMAL(18,6)),
            UltimaAtualizacao
          FROM analytics.vw_DashboardGerencialCompleto
          WHERE TRY_CONVERT(INT, LEFT(Periodo, 4)) IS NOT NULL
        ),
        Totais AS
        (
          SELECT
            Ano,
            MesesAtivos = COUNT_BIG(1),
            ReceitaBrutaAnual = SUM(ReceitaBruta),
            DespesasTotaisAnuais = SUM(DespesasTotais),
            CustoGatewayAnual = SUM(CustoGateway),
            LucroLiquidoAnual = SUM(LucroLiquido),
            MargemMediaPct = AVG(MargemPct),
            UltimaAtualizacao = MAX(UltimaAtualizacao)
          FROM Mensal
          GROUP BY Ano
        )
        SELECT TOP (${limit})
          T1.Ano,
          MesesAtivos = CAST(T1.MesesAtivos AS INT),
          ReceitaBrutaAnual = CAST(ROUND(T1.ReceitaBrutaAnual, 2) AS DECIMAL(18,2)),
          DespesasTotaisAnuais = CAST(ROUND(T1.DespesasTotaisAnuais, 2) AS DECIMAL(18,2)),
          CustoGatewayAnual = CAST(ROUND(T1.CustoGatewayAnual, 2) AS DECIMAL(18,2)),
          LucroLiquidoAnual = CAST(ROUND(T1.LucroLiquidoAnual, 2) AS DECIMAL(18,2)),
          MargemMediaPct = CAST(ROUND(T1.MargemMediaPct, 2) AS DECIMAL(18,2)),
          CrescimentoReceitaPct = CAST(ROUND(((T1.ReceitaBrutaAnual - T0.ReceitaBrutaAnual) / NULLIF(T0.ReceitaBrutaAnual, 0)) * 100.0, 2) AS DECIMAL(18,2)),
          CrescimentoLucroPct = CAST(ROUND(((T1.LucroLiquidoAnual - T0.LucroLiquidoAnual) / NULLIF(T0.LucroLiquidoAnual, 0)) * 100.0, 2) AS DECIMAL(18,2)),
          CrescimentoDespesaPct = CAST(ROUND(((T1.DespesasTotaisAnuais - T0.DespesasTotaisAnuais) / NULLIF(T0.DespesasTotaisAnuais, 0)) * 100.0, 2) AS DECIMAL(18,2)),
          UltimaAtualizacao = ISNULL(T1.UltimaAtualizacao, SYSDATETIME())
        FROM Totais T1
        LEFT JOIN Totais T0
          ON T1.Ano = T0.Ano + 1
        ORDER BY ${orderBy};
      `
    );

    return result.recordset;
  },

  /* --------------------------------------------------------------------
     🧑‍🤝‍🧑 USUÁRIOS
  -------------------------------------------------------------------- */
  retencaoPacientes(usuario, f)           { return this.fetchView(usuario, 'analytics.vw_RetencaoPacientes', f); },
  atividadePacientes(usuario, f)          { return this.fetchView(usuario, 'analytics.vw_AtividadePacientesMensal', f); },

  /* --------------------------------------------------------------------
     🏃‍♂️ FISIOTERAPEUTAS
  -------------------------------------------------------------------- */
  topFisioterapeutas(usuario, f)          { return this.fetchView(usuario, 'analytics.vw_TopFisioterapeutas', f); },
  fisioPerformanceMensal(usuario, f)      { return this.fetchView(usuario, 'analytics.vw_FisioPerformanceMensalResumo', f); },
  fisioIndicacoesResumo(usuario, f)       { return this.fetchView(usuario, 'analytics.vw_FisioIndicacoesResumo', f); },
  fisioAssinaturasPremium(usuario, f)     { return this.fetchView(usuario, 'analytics.vw_FisioAssinaturasPremium', f); },
  fisioPontuacaoHistorico(usuario, f)     { return this.fetchView(usuario, 'dbo.vw_FisioPontuacaoHistorico', f); },

  /* --------------------------------------------------------------------
     🩺 CONSULTAS / PIPELINE
  -------------------------------------------------------------------- */
  consultasPorEspecialidade(usuario, f)   { return this.fetchView(usuario, 'analytics.vw_ConsultasPorEspecialidade', f); },
  consultasStatus(usuario, f)             { return this.fetchView(usuario, 'dbo.vw_ConsultasStatus', f); },
  especialidadesAtivas(usuario, f)        { return this.fetchView(usuario, 'dbo.vw_EspecialidadesAtivas', f); },
  funnelConsultas(usuario, f)             { return this.fetchView(usuario, 'analytics.vw_FunnelConsultas', f); },

  /* --------------------------------------------------------------------
     🛡️ AUDITORIA & DOCUMENTOS
  -------------------------------------------------------------------- */
  auditoriaMensagens(usuario, f)          { return this.fetchView(usuario, 'dbo.vw_AuditoriaMensagens', f); },
  documentosValidacao(usuario, f)         { return this.fetchView(usuario, 'dbo.vw_DocumentosFisioterapeutas', f); },

  /* --------------------------------------------------------------------
     🤝 QUALIDADE / RISCO
  -------------------------------------------------------------------- */
  sinaisBypass(usuario, f)                { return this.fetchView(usuario, 'analytics.vw_SinaisBypass', f); },
  fisioAtendimentosPendentes(usuario, f)  { return this.fetchView(usuario, 'analytics.vw_FisioAtendimentosPendentes', f); },

  /* --------------------------------------------------------------------
     💬 CHAT / MODERAÇÃO
  -------------------------------------------------------------------- */
  chatResumo(usuario, f)                  { return this.fetchView(usuario, 'analytics.vw_ChatModerationResumo', f); },
  chatResumoDiario(usuario, f)            { return this.fetchView(usuario, 'analytics.vw_ChatModerationResumoDiario', f); },
  chatStats(usuario, f)                   { return this.fetchView(usuario, 'analytics.vw_ChatModerationStats', f); },
  chatAlertas(usuario, f)                 { return this.fetchView(usuario, 'analytics.vw_ChatModerationAlertas', f); },
  async chatReincidentes(usuario, filtros) {
    if (String(usuario?.tipo || '').toLowerCase() !== 'admin') {
      throw new HttpError(403, 'Acesso negado.');
    }

    const filtrosObj = { ...(filtros || {}) };
    let limit = 200;
    if (Object.prototype.hasOwnProperty.call(filtrosObj, 'limit')) {
      const parsed = Number(filtrosObj.limit);
      if (!Number.isNaN(parsed) && parsed > 0) limit = Math.min(parsed, MAX_LIMIT);
    }

    const orderBy = normalizeOrderBy(filtrosObj.orderBy) || 'TotalBloqueios DESC, UltimaTentativa DESC';
    const query = `
      SELECT TOP (${limit})
        R.RemetenteId,
        NomeRemetente = COALESCE(t.NomeRemetente, CONCAT(N'Remetente ', R.RemetenteId)),
        TipoUsuario   = COALESCE(t.TipoUsuario, N'Desconhecido'),
        R.TotalBloqueios,
        R.DiasAtivos,
        R.UltimaTentativa,
        R.MotivosDetectados
      FROM analytics.vw_ChatModerationUsuariosReincidentes R
      OUTER APPLY (
        SELECT TOP 1
          TipoUsuario = CASE
            WHEN C.PacienteId       = R.RemetenteId THEN N'Paciente'
            WHEN C.FisioterapeutaId = R.RemetenteId THEN N'Fisioterapeuta'
          END,
          NomeRemetente = CASE
            WHEN C.PacienteId       = R.RemetenteId THEN P.Nome
            WHEN C.FisioterapeutaId = R.RemetenteId THEN F.Nome
          END
        FROM dbo.ChatModerationLogs L
        JOIN dbo.Consultas C
          ON C.Id = L.ConsultaId
          AND (C.PacienteId = R.RemetenteId OR C.FisioterapeutaId = R.RemetenteId)
        LEFT JOIN dbo.Pacientes P       ON P.Id = C.PacienteId
        LEFT JOIN dbo.Fisioterapeutas F ON F.Id = C.FisioterapeutaId
        WHERE L.RemetenteId   = R.RemetenteId
          AND L.ConsultaId IS NOT NULL
        ORDER BY L.CriadoEm DESC
      ) t
      ORDER BY ${orderBy};
    `;

    const result = await queryWithContext(usuario, (request) => request, query);
    return result.recordset;
  },

  /* --------------------------------------------------------------------
     🖥️ MONITORAMENTO SQL (JOB HEALTH / CACHE)
  -------------------------------------------------------------------- */
  logAtualizacaoCache(usuario, f)         { return this.fetchView(usuario, 'analytics.vw_LogAtualizacaoCache', f); },
  logCacheResumo(usuario, f)              { return this.fetchView(usuario, 'analytics.vw_LogCacheResumo', f); },
  jobsStatus(usuario, f)                  { return this.fetchView(usuario, 'dbo.vw_JobsStatus', f); },
  execucoesJobs(usuario, f)               { return this.fetchView(usuario, 'dbo.vw_LogExecucoesJobs', f); },

  /* --------------------------------------------------------------------
     👑 ASSINATURA PREMIUM ATUAL
  -------------------------------------------------------------------- */
  assinaturaPremiumAtual(usuario, f)      { return this.fetchView(usuario, 'dbo.vw_AssinaturaPremiumAtual', f); },

  /* --------------------------------------------------------------------
     🔍 Endpoint livre para explorar qualquer view
  -------------------------------------------------------------------- */
  monitor(usuario, viewName, f)           { return this.fetchView(usuario, viewName, f); }

};

export default adminAnalyticsService;
