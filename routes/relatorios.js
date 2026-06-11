// 📁 routes/relatorios.js
import express from 'express';
import relatoriosController from '../controllers/relatoriosController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

// 🔒 Garante req.usuario em TODAS as rotas abaixo
router.use(autenticarJWT, requireAuth);

router.get(
  '/pontuacao',
  verificarPermissao(['Fisioterapeuta']),
  relatoriosController.pontuacao
);

export default router;

