//  routes/index.js

//  Importações principais
import express from 'express';

//  Rotas de módulos
import especialidadesRoutes from './especialidades.js';
import pacientesRoutes from './pacientes.js';
import fisioterapeutasRoutes from './fisioterapeutas.js';
import consultasRoutes from './consultas.js';
import localizacoesRoutes from './localizacoes.js';
import agendaRoutes from './agenda.js';
import adminRoutes from './admin.js';
import adminAnalyticsRoutes from './adminAnalytics.js';
import arquivosRoutes from './arquivos.js';
import videosRoutes from './videos.js';
import fisioPacientesRoutes from './fisioPacientes.js';
import prontuariosRoutes from './prontuarios.js';
import indicadoresRoutes from './indicadores.js';
import chatRoutes from './chat.js';
import indicacoesRoutes from './indicacoes.js';
import premiumRoutes from './premium.js';
import carteiraRoutes from './carteira.js';
import creditosRoutes from './creditos.js';
import pacotesRoutes from './pacotes.js';
import favoritosRoutes from './favoritos.js';
import disputasRoutes from './disputas.js';
import recibosRoutes from './recibos.js';
import avaliacoesRoutes from './avaliacoes.js';
import relatoriosRoutes from './relatorios.js';
import legaisRoutes from './legais.js';
import exigirAceiteLegais from '../middleware/exigirAceiteLegais.js';
import suporteRoutes from './suporteRoutes.js';
import denunciasRoutes from './denuncias.js';
import adminDenunciasRoutes from './adminDenuncias.js';
import pagamentosGatewayRoutes from './pagamentosGateway.js';
import parametrosSistemaRoutes from './parametrosSistema.js';
import cadastroRoutes from './cadastro.js';
import notificacoesRoutes from './notificacoes.js';


//  Middlewares globais
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';

const router = express.Router();

/* ----------------------------------------
    Healthcheck / Status (PÚBLICO)
---------------------------------------- */
router.get('/healthz', (_req, res) => res.status(200).send('OK'));

router.get('/status', (_req, res) => {
  res.json({
    sucesso: true,
    mensagem: ' API principal está ativa e operante!',
    timestamp: new Date().toISOString()
  });
});

/* ----------------------------------------
    Rotas públicas (SEM autenticação)
---------------------------------------- */
//  Catálogos públicos
router.use('/especialidades', especialidadesRoutes);
router.use('/cadastro', cadastroRoutes);

//  Pacientes: cadastro público (POST /pacientes) e o próprio arquivo /pacientes.js aplica JWT no restante
router.use('/pacientes', pacientesRoutes);

//  Fisioterapeuta: rotas públicas (catálogo) + rotas internas protegidas dentro do módulo
router.use('/fisioterapeutas', fisioterapeutasRoutes);

// Pagamentos (webhook/confirmacoes) — permissões dentro do módulo
router.use('/pagamentos', pagamentosGatewayRoutes);
router.use('/parametros-sistema', parametrosSistemaRoutes);
router.use('/arquivos', arquivosRoutes);

/* ----------------------------------------
    Administração (Painel Admin)
    IMPORTANTE: /admin/analytics ANTES de /admin
---------------------------------------- */
router.use('/admin/analytics', adminAnalyticsRoutes);
router.use('/admin/denuncias', adminDenunciasRoutes);
router.use('/admin', adminRoutes);

/* ----------------------------------------
    Rotas protegidas (somente logado)
---------------------------------------- */

//  aplica auth uma vez para tudo abaixo
router.use(autenticarJWT, requireAuth);

//  Termos e Politica de Privacidade
router.use('/legais', legaisRoutes);

//  Notificacoes push: precisa funcionar logo apos login, antes do gate de aceite legal
router.use('/notificacoes', notificacoesRoutes);

//  bloqueia o resto até aceitar Termos e Politica
router.use(exigirAceiteLegais);

//  Vídeos (upload/listar/visualizar vídeo bruto) — permissões dentro do módulo
router.use('/videos', videosRoutes);

//  Agenda (rotina + bloqueios) — permissões dentro do módulo
router.use('/agenda', agendaRoutes);

//  Consultas
router.use('/consultas', consultasRoutes);

//Denuncia - Reportar usuário
router.use('/denuncias', denunciasRoutes);

//  Paciente — Favoritos
router.use('/favoritos', favoritosRoutes);

//  Paciente — Disputas
router.use('/disputas', disputasRoutes);

//  Paciente — Recibos
router.use('/recibos', recibosRoutes);

//  Paciente — Avaliações
router.use('/avaliacoes', avaliacoesRoutes);

//  Localizações (Fisio)
router.use('/localizacoes', localizacoesRoutes);

//  Área do Fisio (pacientes atendidos + prontuários + indicadores)
router.use('/fisio', fisioPacientesRoutes);
router.use('/fisio', prontuariosRoutes);
router.use('/fisio', indicadoresRoutes);

//  Chat
router.use('/chat', chatRoutes);

//  Indicações
router.use('/indicacoes', indicacoesRoutes);

//  Premium
router.use('/fisio/premium', premiumRoutes);

//  Carteira Fisioterapeuta
router.use('/carteira', carteiraRoutes);

//  Relatorios Fisioterapeuta
router.use('/relatorios', relatoriosRoutes);

//  Créditos Paciente
router.use('/creditos', creditosRoutes);

//  Pacotes Paciente
router.use('/pacotes', pacotesRoutes);

//  Suporte
router.use('/suporte', suporteRoutes);

export default router;





