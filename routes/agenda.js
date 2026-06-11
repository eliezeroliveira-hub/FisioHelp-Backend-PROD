// 📁 routes/agenda.js
import express from 'express';
import agendaController from '../controllers/agendaController.js';
import { autenticarJWT } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

// 🔒 Garante req.usuario em TODAS as rotas abaixo
router.use(autenticarJWT);

/**
 * Calendário (rotina + bloqueios + consultas)
 * GET /agenda/me/calendario?mes=YYYY-MM
 * ou /agenda/me/calendario?de=YYYY-MM-DD&ate=YYYY-MM-DD
 */
router.get(
  '/me/calendario',
  verificarPermissao(['Fisioterapeuta']),
  agendaController.obterMeuCalendario
);

/**
 * 🔒 Rotas do Fisioterapeuta (CRUD rotina semanal)
 */
router.get('/me/rotina', verificarPermissao(['Fisioterapeuta']), agendaController.listarMinhaAgenda);
router.post('/me/rotina', verificarPermissao(['Fisioterapeuta']), agendaController.criarAgenda);
router.patch('/me/rotina/:id', verificarPermissao(['Fisioterapeuta']), agendaController.atualizarAgenda);
router.delete('/me/rotina/:id', verificarPermissao(['Fisioterapeuta']), agendaController.excluirAgenda);

/**
 * 🔒 Rotas do Fisioterapeuta (CRUD bloqueios por data)
 */
router.get('/me/bloqueios', verificarPermissao(['Fisioterapeuta']), agendaController.listarMeusBloqueios);
router.post('/me/bloqueios', verificarPermissao(['Fisioterapeuta']), agendaController.criarBloqueio);
router.patch('/me/bloqueios/:id', verificarPermissao(['Fisioterapeuta']), agendaController.atualizarBloqueio);
router.delete('/me/bloqueios/:id', verificarPermissao(['Fisioterapeuta']), agendaController.excluirBloqueio);

/**
 * 🔒 Rotas do Fisioterapeuta (CRUD exceções por data)
 */
router.get('/me/excecoes', verificarPermissao(['Fisioterapeuta']), agendaController.listarMinhasExcecoes);
router.post('/me/excecoes', verificarPermissao(['Fisioterapeuta']), agendaController.criarExcecao);
router.patch('/me/excecoes/:id', verificarPermissao(['Fisioterapeuta']), agendaController.atualizarExcecao);
router.delete('/me/excecoes/:id', verificarPermissao(['Fisioterapeuta']), agendaController.excluirExcecao);

/**
 * 👀 Visão (rotina semanal) — paciente/fisio podem ver (autenticados)
 */
router.get(
  '/fisioterapeuta/:fisioterapeutaId/rotina',
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  agendaController.obterAgendaPublica
);

export default router;
