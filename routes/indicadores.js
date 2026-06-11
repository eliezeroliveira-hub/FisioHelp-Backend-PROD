// 📁 routes/indicadores.js
import express from 'express';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';
import indicadoresController from '../controllers/indicadoresController.js';

const router = express.Router();

// 🔒 garante req.usuario em TODAS as rotas abaixo
router.use(autenticarJWT, requireAuth);

// GET /fisio/indicadores
router.get(
  '/indicadores',
  verificarPermissao(['Fisioterapeuta']),
  indicadoresController.obter
);

export default router;
