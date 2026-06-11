// 📁 routes/adminAnalytics.js
import express from 'express';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';
import requireAdminPagePermission from '../middleware/adminPagePermission.js';
import adminAnalyticsService from '../services/adminAnalyticsService.js';

const router = express.Router();

// 🔒 Todas as rotas exigem ADMIN
router.use(autenticarJWT, requireAuth, verificarPermissao(['Admin']));

// 🔒 Permissões por grupo de página
router.use('/financeiro', requireAdminPagePermission('relatorios-financeiros'));
router.use(
  ['/usuarios', '/consultas', '/chat', '/auditoria', '/documentos', '/qualidade', '/monitor', '/assinaturas'],
  requireAdminPagePermission('relatorios-plataforma')
);

// Helper: wrapper para async routes
const wrap = (fn) => async (req, res) => {
  try {
    const data = await fn(req, res);
    // se o handler já respondeu (ex.: validação), não tenta responder de novo
    if (res.headersSent) return;
    return res.json({ sucesso: true, data });
  } catch (err) {
    const status = err?.statusCode || err?.httpStatus || 500;
    return res.status(status).json({
      sucesso: false,
      mensagem: 'Erro ao processar requisição de analytics.',
      erro: status >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro interno.')
    });
  }
};

const parseId = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const call = (method, req, ...args) => {
  const fn = adminAnalyticsService?.[method];
  if (typeof fn !== 'function') throw new Error(`Método ${method} não encontrado no adminAnalyticsService.`);
  // Compatível com services antigos (fn(query)) e novos (fn(usuario, query))
  if (fn.length >= 2) return fn.call(adminAnalyticsService, req.usuario, ...args);
  return fn.call(adminAnalyticsService, ...args);
};

const callMonitor = (req, view, query) => {
  const fn = adminAnalyticsService?.monitor;
  if (typeof fn !== 'function') throw new Error('Método monitor não encontrado no adminAnalyticsService.');
  // Compatível com services antigos (monitor(view, query)) e novos (monitor(usuario, view, query))
  if (fn.length >= 3) return fn.call(adminAnalyticsService, req.usuario, view, query);
  return fn.call(adminAnalyticsService, view, query);
};


/* ---------------------- FINANCEIRO GERAL ---------------------- */
router.get('/financeiro/dashboard-gerencial',   wrap((req) => call('dashboardGerencial', req, req.query)));
router.get('/financeiro/resumo-mensal',         wrap((req) => call('resumoFinanceiroMensal', req, req.query)));
router.get('/financeiro/resumo-anual',          wrap((req) => call('resumoFinanceiroAnual', req, req.query)));
router.get('/financeiro/faturamento',           wrap((req) => call('faturamentoMensal', req, req.query)));
router.get('/financeiro/faturamento-historico', wrap((req) => call('faturamentoMensalHistorico', req, req.query)));
router.get('/financeiro/indicadores',           wrap((req) => call('indicadoresFinanceiros', req, req.query)));
router.get('/financeiro/pipeline',              wrap((req) => call('pipelineFinanceiro', req, req.query)));
router.get('/financeiro/repasses-pendentes',    wrap((req) => call('repassesPendentes', req, req.query)));
router.get('/financeiro/analise-operacional',   wrap((req) => call('analiseOperacional', req, req.query)));
router.get('/financeiro/transacoes',            wrap((req) => call('transacoes', req, req.query)));
router.get('/financeiro/logs-financeiros',      wrap((req) => call('logsFinanceiros', req, req.query)));

/* ---------------------- DESPESAS ---------------------- */
router.get('/financeiro/despesas', wrap((req) => call('despesasView', req, req.query)));

router.post('/financeiro/despesas', wrap((req) => call('inserirDespesa', req, req.body)));

router.put('/financeiro/despesas/:id', wrap((req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ sucesso: false, mensagem: 'Parâmetro :id inválido.' });
  return call('atualizarDespesa', req, id, req.body);
}));

router.delete('/financeiro/despesas/:id', wrap((req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ sucesso: false, mensagem: 'Parâmetro :id inválido.' });
  return call('excluirDespesa', req, id);
}));

/* ---------------------- CRESCIMENTO ---------------------- */
router.get('/crescimento/usuarios', requireAdminPagePermission('relatorios-plataforma'), wrap((req) => call('crescimentoUsuarios', req, req.query)));
router.get('/crescimento/projecao-mensal', requireAdminPagePermission('relatorios-plataforma'), wrap((req) => call('projecaoMensal', req, req.query)));
router.get('/crescimento/projecao-anual', requireAdminPagePermission(['relatorios-financeiros', 'relatorios-plataforma']), wrap((req) => call('projecaoAnual', req, req.query)));

/* ---------------------- USUÁRIOS ---------------------- */
router.get('/usuarios/retencao',            wrap((req) => call('retencaoPacientes', req, req.query)));
router.get('/usuarios/atividade-pacientes', wrap((req) => call('atividadePacientes', req, req.query)));

/* ---------------------- FISIOTERAPEUTAS ---------------------- */
router.get('/fisio/top',                requireAdminPagePermission('relatorios-plataforma'), wrap((req) => call('topFisioterapeutas', req, req.query)));
router.get('/fisio/performance-mensal', requireAdminPagePermission('relatorios-plataforma'), wrap((req) => call('fisioPerformanceMensal', req, req.query)));
router.get('/fisio/indicacoes',         requireAdminPagePermission(['relatorios', 'relatorios-plataforma']), wrap((req) => call('fisioIndicacoesResumo', req, req.query)));
router.get('/fisio/assinaturas-premium',requireAdminPagePermission('relatorios-plataforma'), wrap((req) => call('fisioAssinaturasPremium', req, req.query)));
router.get('/fisio/pontuacao-historico',requireAdminPagePermission('relatorios-plataforma'), wrap((req) => call('fisioPontuacaoHistorico', req, req.query)));

/* ---------------------- CONSULTAS ---------------------- */
router.get('/consultas/especialidades',        wrap((req) => call('consultasPorEspecialidade', req, req.query)));
router.get('/consultas/status',                wrap((req) => call('consultasStatus', req, req.query)));
router.get('/consultas/especialidades-ativas', wrap((req) => call('especialidadesAtivas', req, req.query)));
router.get('/consultas/funnel',                wrap((req) => call('funnelConsultas', req, req.query)));

/* ---------------------- CHAT ---------------------- */
router.get('/chat/resumo',        wrap((req) => call('chatResumo', req, req.query)));
router.get('/chat/resumo-diario', wrap((req) => call('chatResumoDiario', req, req.query)));
router.get('/chat/stats',         wrap((req) => call('chatStats', req, req.query)));
router.get('/chat/alertas',       wrap((req) => call('chatAlertas', req, req.query)));
router.get('/chat/reincidentes',  wrap((req) => call('chatReincidentes', req, req.query)));

/* ---------------------- AUDITORIA & DOCUMENTOS ---------------------- */
router.get('/auditoria/mensagens',  wrap((req) => call('auditoriaMensagens', req, req.query)));
router.get('/documentos/validacao', wrap((req) => call('documentosValidacao', req, req.query)));

/* ---------------------- QUALIDADE / RISCO ---------------------- */
router.get('/qualidade/sinais-bypass',                wrap((req) => call('sinaisBypass', req, req.query)));
router.get('/qualidade/fisio-atendimentos-pendentes', wrap((req) => call('fisioAtendimentosPendentes', req, req.query)));

/* ---------------------- MONITORAMENTO SQL ---------------------- */
router.get('/monitor/sql/log-atualizacao-cache', wrap((req) => call('logAtualizacaoCache', req, req.query)));
router.get('/monitor/sql/log-cache-resumo',      wrap((req) => call('logCacheResumo', req, req.query)));
router.get('/monitor/sql/jobs-status',           wrap((req) => call('jobsStatus', req, req.query)));
router.get('/monitor/sql/execucoes-jobs',        wrap((req) => call('execucoesJobs', req, req.query)));

/* ---------------------- ASSINATURA PREMIUM ATUAL ---------------------- */
router.get('/assinaturas/premium-atual', wrap((req) => call('assinaturaPremiumAtual', req, req.query)));

/* ---------------------- MONITORAMENTO DINÂMICO (qualquer view) ---------------------- */
router.get('/monitor', wrap(async (req, res) => {
  const view = req.query?.view;
  if (!view) return res.status(400).json({ sucesso: false, mensagem: 'Informe o parâmetro ?view=' });
  // mantive a assinatura: monitor(view, query)
  return callMonitor(req, view, req.query);
}));

export default router;
