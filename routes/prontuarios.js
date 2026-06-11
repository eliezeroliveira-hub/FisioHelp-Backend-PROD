// routes/prontuarios.js
import express from 'express';
import verificarPermissao from '../middleware/verificarPermissao.js';
import prontuariosController from '../controllers/prontuariosController.js';

const router = express.Router();

/**
 * Este módulo deve ser montado em /fisio no routes/index.js
 * Ex: router.use('/fisio', autenticarJWT, requireAuth, prontuariosRoutes)
 */

router.get(
  '/pacientes/:id/prontuario',
  verificarPermissao(['Fisioterapeuta']),
  prontuariosController.obter
);

router.post(
  '/pacientes/:id/prontuario',
  verificarPermissao(['Fisioterapeuta']),
  prontuariosController.criar
);

router.patch(
  '/pacientes/:id/prontuario',
  verificarPermissao(['Fisioterapeuta']),
  prontuariosController.atualizar
);

router.post(
  '/pacientes/:id/prontuario/assinar',
  verificarPermissao(['Fisioterapeuta']),
  prontuariosController.assinar
);

router.get(
  '/pacientes/:id/prontuario/pdf',
  verificarPermissao(['Fisioterapeuta']),
  prontuariosController.baixarPdf
);

export default router;
