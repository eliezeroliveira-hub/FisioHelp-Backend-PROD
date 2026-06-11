// 📁 routes/fisioPacientes.js
import express from 'express';
import fisioPacientesController from '../controllers/fisioPacientesController.js';
import { autenticarJWT } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

// 🔒 garante req.usuario em TODAS as rotas abaixo
router.use(autenticarJWT);

// 🔒 Apenas fisioterapeuta autenticado
router.get(
  '/me/pacientes',
  verificarPermissao(['Fisioterapeuta']),
  fisioPacientesController.listar
);

router.get(
  '/me/pedidos-medicos',
  verificarPermissao(['Fisioterapeuta']),
  fisioPacientesController.listarPedidosMedicos
);

export default router;
