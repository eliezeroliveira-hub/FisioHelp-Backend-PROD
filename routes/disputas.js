// 📁 routes/disputas.js
import express from 'express';
import disputasController from '../controllers/disputasController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

router.use(autenticarJWT, requireAuth);

// Listar disputas do próprio usuário (Paciente e Fisioterapeuta)
router.get(
  '/',
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  disputasController.listar
);

// Evidências da consulta (Admin)
router.get(
  '/consultas/:consultaId/evidencias',
  verificarPermissao(['Admin']),
  disputasController.evidenciasConsulta
);

// Abrir disputa (Paciente)
router.post(
  '/abrir',
  verificarPermissao(['Paciente']),
  disputasController.abrir
);

// Marcar em análise (Admin)
router.patch(
  '/:disputaId/em-analise',
  verificarPermissao(['Admin']),
  disputasController.marcarEmAnalise
);

// Resolver (Admin)
router.post(
  '/:disputaId/resolver',
  verificarPermissao(['Admin']),
  disputasController.resolver
);

export default router;
