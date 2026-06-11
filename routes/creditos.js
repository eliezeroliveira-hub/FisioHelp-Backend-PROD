// 📁 routes/creditos.js
import express from 'express';
import creditosController from '../controllers/creditosController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

router.use(autenticarJWT, requireAuth);

// 💳 Créditos do paciente (dbo.CreditosPacientes)
router.get(
  '/saldo',
  verificarPermissao(['Paciente']),
  creditosController.saldo
);

router.get(
  '/',
  verificarPermissao(['Paciente']),
  creditosController.listar
);

export default router;
