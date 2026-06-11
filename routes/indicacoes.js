// 📁 routes/indicacoes.js
import express from 'express';
import indicacoesController from '../controllers/indicacoesController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

router.use(autenticarJWT, requireAuth);

router.get(
  '/minhas',
  verificarPermissao(['Fisioterapeuta']),
  indicacoesController.minhas
);

router.get(
  '/meu-codigo',
  verificarPermissao(['Fisioterapeuta']),
  indicacoesController.meuCodigo
);

export default router;
