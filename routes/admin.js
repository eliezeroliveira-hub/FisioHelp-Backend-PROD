// 📁 routes/admin.js
import express from 'express';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';
import requireAdminPagePermission from '../middleware/adminPagePermission.js';
import adminController from '../controllers/adminController.js';
import parametrosController from '../controllers/parametrosController.js';
import administradoresController from '../controllers/administradoresController.js';
import adminLegaisRoutes from './adminLegais.js';

const router = express.Router();

/**
 * 🔒 Todas as rotas deste arquivo exigem:
 * - JWT válido
 * - Tipo de usuário: Admin
 *
 * Dica: normalmente este router é montado em algo como:
 * app.use('/admin', adminRoutes);
 */
router.use(autenticarJWT, requireAuth, verificarPermissao(['Admin']));

/* ----------------------------------------
   👤 ADMINISTRADORES (CADASTRO / SENHA)
---------------------------------------- */
// ✅ Apenas ADMIN (já filtrado pelo router.use).
// 🔒 Ações Master são validadas no service (NivelAcesso = 'Master').
router.get('/administradores', requireAdminPagePermission('admins'), administradoresController.listar);
router.post('/administradores', requireAdminPagePermission('admins'), administradoresController.criar);
router.get('/administradores/permissoes', administradoresController.listarPermissoes);
router.put('/administradores/permissoes', requireAdminPagePermission('admins'), administradoresController.atualizarPermissoes);
router.put('/administradores/me/senha', administradoresController.alterarMinhaSenha);
router.put('/administradores/:id/senha', requireAdminPagePermission('admins'), administradoresController.resetarSenha);
router.patch('/administradores/:id/nivel-acesso', requireAdminPagePermission('admins'), administradoresController.alterarNivelAcesso);
router.patch('/administradores/:id/ativar', requireAdminPagePermission('admins'), administradoresController.ativar);
router.patch('/administradores/:id/desativar', requireAdminPagePermission('admins'), administradoresController.desativar);


/* ----------------------------------------
   📄 TERMOS E POLITICAS DE PRIVACIDADE
---------------------------------------- */
router.use('/legais', requireAdminPagePermission('parametros'), adminLegaisRoutes);

/* ----------------------------------------
   📊 DASHBOARD / PAINEL FINANCEIRO
---------------------------------------- */
router.get('/dashboard-financeiro', requireAdminPagePermission('relatorios-financeiros'), adminController.dashboardFinanceiro);
router.get('/analytics/dashboard-gerencial', requireAdminPagePermission('relatorios-financeiros'), adminController.dashboardGerencial);

/* ----------------------------------------
   📄 DOCUMENTOS DOS FISIOTERAPEUTAS
---------------------------------------- */
router.get('/documentos/pendentes', requireAdminPagePermission('documentos'), adminController.documentosPendentes);
router.post('/documentos/:documentoId/validar', requireAdminPagePermission('documentos'), adminController.validarDocumento);
router.get('/documentos/:documentoId/download', requireAdminPagePermission('documentos'), adminController.downloadDocumento);
router.get('/auditoria/acoes-admin', requireAdminPagePermission('relatorios'), adminController.listarAuditoriaAcoesAdmin);

/* ----------------------------------------
   🚨 GESTÃO DE FISIOTERAPEUTAS
---------------------------------------- */
// 📋 Listar
router.get('/fisioterapeutas', requireAdminPagePermission('fisioterapeutas'), adminController.listarFisioterapeutas);

// 🔒 Bloquear / Desbloquear
router.patch('/fisioterapeutas/:id/bloquear', requireAdminPagePermission('fisioterapeutas'), adminController.bloquearFisioterapeuta);
router.patch('/fisioterapeutas/:id/desbloquear', requireAdminPagePermission('fisioterapeutas'), adminController.desbloquearFisioterapeuta);

// 🔧 Ativar / Desativar
router.patch('/fisioterapeutas/:id/ativar', requireAdminPagePermission('fisioterapeutas'), adminController.ativarFisioterapeuta);
router.patch('/fisioterapeutas/:id/desativar', requireAdminPagePermission('fisioterapeutas'), adminController.desativarFisioterapeuta);

/* ----------------------------------------
   🚨 BLOQUEIO / ATIVAÇÃO DE PACIENTES
---------------------------------------- */
router.get('/pacientes', requireAdminPagePermission('pacientes'), adminController.listarPacientes);

router.patch('/pacientes/:id/bloquear', requireAdminPagePermission('pacientes'), adminController.bloquearPaciente);
router.patch('/pacientes/:id/desbloquear', requireAdminPagePermission('pacientes'), adminController.desbloquearPaciente);

router.patch('/pacientes/:id/ativar', requireAdminPagePermission('pacientes'), adminController.ativarPaciente);
router.patch('/pacientes/:id/desativar', requireAdminPagePermission('pacientes'), adminController.desativarPaciente);

/* ----------------------------------------
   🎥 VÍDEO DE APRESENTAÇÃO DO FISIOTERAPEUTA (YouTube etc.)
   ✅ Somente ADMIN pode atualizar esse link
---------------------------------------- */
router.patch('/fisioterapeutas/:id/link-video', requireAdminPagePermission('fisioterapeutas'), adminController.atualizarLinkVideoApresentacao);

/* ----------------------------------------
   📦 ASSINATURAS
---------------------------------------- */
router.get('/parametros/assinaturas', requireAdminPagePermission('parametros'), parametrosController.listarAssinaturas);
router.put('/parametros/assinaturas', requireAdminPagePermission('parametros'), parametrosController.atualizarAssinaturas);

/* ----------------------------------------
   ⚙️ PARÂMETROS DO SISTEMA
---------------------------------------- */
router.get('/parametros/sistema',     requireAdminPagePermission('parametros'), parametrosController.listarSistema);
router.put('/parametros/sistema',     requireAdminPagePermission('parametros'), parametrosController.atualizarSistema);

/* ----------------------------------------
   💼 PARÂMETROS FINANCEIROS (PRÓ-LABORE)
---------------------------------------- */
router.get('/parametros/financeiro',  requireAdminPagePermission('parametros'), parametrosController.listarFinanceiro);
router.put('/parametros/financeiro',  requireAdminPagePermission('parametros'), parametrosController.atualizarFinanceiro);

/* ----------------------------------------
   📋 INDICAÇÕES – LISTAGEM
---------------------------------------- */
router.get('/indicacoes', requireAdminPagePermission('relatorios'), adminController.listarIndicacoes);

/* ----------------------------------------
   💲 TAXAS
---------------------------------------- */
router.get('/taxas', requireAdminPagePermission('parametros'), parametrosController.listarTaxas);
router.put('/taxas/:id', requireAdminPagePermission('parametros'), parametrosController.atualizarTaxaPorId);
router.get('/gateway-perfis-custo', requireAdminPagePermission('parametros'), parametrosController.listarGatewayPerfisCusto);
router.post('/gateway-perfis-custo', requireAdminPagePermission('parametros'), parametrosController.versionarGatewayPerfilCusto);
router.post('/gateway-perfis-custo/:id/encerrar', requireAdminPagePermission('parametros'), parametrosController.encerrarGatewayPerfilCusto);
router.get('/gateway-perfis', requireAdminPagePermission('parametros'), parametrosController.listarGatewayPerfisCusto);
router.post('/gateway-perfis', requireAdminPagePermission('parametros'), parametrosController.versionarGatewayPerfilCusto);
router.post('/gateway-perfis/:id/encerrar', requireAdminPagePermission('parametros'), parametrosController.encerrarGatewayPerfilCusto);

/* ----------------------------------------
   🏆 PONTUAÇÃO
---------------------------------------- */
router.get('/pontuacao', requireAdminPagePermission('pontuacao'), parametrosController.listarPontuacao);
router.get('/pontuacao/regras', requireAdminPagePermission('pontuacao'), parametrosController.listarPontuacaoRegras);
router.get('/pontuacao/eventos', requireAdminPagePermission('pontuacao'), parametrosController.listarPontuacaoEventos);
router.put('/pontuacao/regras/:id', requireAdminPagePermission('pontuacao'), parametrosController.atualizarRegra);
router.put('/pontuacao/eventos/:id', requireAdminPagePermission('pontuacao'), parametrosController.atualizarEvento);

/* ----------------------------------------
   ⚖️ DISPUTAS DE CONSULTAS
---------------------------------------- */
// Listar disputas (filtros via query string: status, consultaId, fisioterapeutaId, pacienteId)
router.get('/disputas', requireAdminPagePermission('disputas'), adminController.listarDisputas);

// Evidências / histórico da consulta
router.get('/disputas/:consultaId/evidencias', requireAdminPagePermission('disputas'), adminController.evidenciasConsulta);

// Marcar disputa como "Em análise"
router.post('/disputas/:disputaId/em-analise', requireAdminPagePermission('disputas'), adminController.marcarDisputaEmAnalise);

// Resolver disputa (ProcedentePaciente / ProcedenteFisio / Cancelada)
router.post('/disputas/:disputaId/resolver', requireAdminPagePermission('disputas'), adminController.resolverDisputa);

/* ----------------------------------------
   📈 ANALYTICS — FINANCEIRO
---------------------------------------- */
router.get('/analytics/financeiro/resumo-mensal', requireAdminPagePermission('relatorios-financeiros'), adminController.resumoFinanceiroMensal);
router.get('/analytics/financeiro/faturamento-mensal', requireAdminPagePermission('relatorios-financeiros'), adminController.faturamentoMensal);
router.get('/analytics/financeiro/faturamento-mensal-historico', requireAdminPagePermission('relatorios-financeiros'), adminController.faturamentoMensalHistorico);
router.get('/analytics/financeiro/indicadores', requireAdminPagePermission('relatorios-financeiros'), adminController.indicadoresFinanceiros);
router.get('/analytics/financeiro/repasses-pendentes', requireAdminPagePermission('relatorios-financeiros'), adminController.repassesPendentes);

/* ----------------------------------------
   📊 ANALYTICS — CRESCIMENTO
---------------------------------------- */
router.get('/analytics/crescimento/usuarios', requireAdminPagePermission('relatorios-plataforma'), adminController.crescimentoUsuarios);
router.get('/analytics/crescimento/projecao-mensal', requireAdminPagePermission('relatorios-plataforma'), adminController.projecaoMensal);
router.get('/analytics/crescimento/projecao-anual', requireAdminPagePermission('relatorios-plataforma'), adminController.projecaoAnual);

/* ----------------------------------------
   🧑‍⚕️ ANALYTICS — FISIOTERAPEUTAS
---------------------------------------- */
router.get('/analytics/fisioterapeutas/top', requireAdminPagePermission('relatorios-plataforma'), adminController.topFisioterapeutas);
router.get('/analytics/fisioterapeutas/performance-mensal', requireAdminPagePermission('relatorios-plataforma'), adminController.fisioPerformanceMensal);
router.get('/analytics/fisioterapeutas/indicacoes', requireAdminPagePermission('relatorios-plataforma'), adminController.fisioIndicacoesResumo);
router.get('/analytics/fisioterapeutas/assinaturas', requireAdminPagePermission('relatorios-plataforma'), adminController.fisioAssinaturasPremium);

/* ----------------------------------------
   🧍‍♂️ ANALYTICS — PACIENTES
---------------------------------------- */
router.get('/analytics/usuarios/retencao', requireAdminPagePermission('relatorios-plataforma'), adminController.retencaoPacientes);
router.get('/analytics/usuarios/atividade', requireAdminPagePermission('relatorios-plataforma'), adminController.atividadePacientes);

/* ----------------------------------------
   🩺 ANALYTICS — CONSULTAS
---------------------------------------- */
router.get('/analytics/consultas/especialidades', requireAdminPagePermission('relatorios-plataforma'), adminController.consultasPorEspecialidade);
router.get('/analytics/consultas/funnel', requireAdminPagePermission('relatorios-plataforma'), adminController.funnelConsultas);

/* ----------------------------------------
   🛡️ ANALYTICS — AUDITORIA / QUALIDADE
---------------------------------------- */
router.get('/analytics/qualidade/sinais-bypass', requireAdminPagePermission('relatorios-plataforma'), adminController.sinaisBypass);
router.get('/analytics/qualidade/atendimentos-pendentes', requireAdminPagePermission('relatorios-plataforma'), adminController.fisioAtendimentosPendentes);

/* ----------------------------------------
   💬 ANALYTICS — CHAT
---------------------------------------- */
router.get('/analytics/chat/resumo', requireAdminPagePermission('relatorios-plataforma'), adminController.chatResumo);
router.get('/analytics/chat/resumo-diario', requireAdminPagePermission('relatorios-plataforma'), adminController.chatResumoDiario);
router.get('/analytics/chat/stats', requireAdminPagePermission('relatorios-plataforma'), adminController.chatStats);
router.get('/analytics/chat/alertas', requireAdminPagePermission('relatorios-plataforma'), adminController.chatAlertas);
router.get('/analytics/chat/reincidentes', requireAdminPagePermission('relatorios-plataforma'), adminController.chatReincidentes);

/* ----------------------------------------
   🧭 MONITORAMENTO DE VIEW DINÂMICA
---------------------------------------- */
router.get('/analytics/monitor/:view', requireAdminPagePermission('relatorios-plataforma'), adminController.monitor);

export default router;
