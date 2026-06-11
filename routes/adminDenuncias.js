// routes/adminDenuncias.js
import express from 'express';
import denunciasController from '../controllers/denunciasController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

router.use(autenticarJWT, requireAuth);

router.get(
  '/',
  verificarPermissao(['Admin']),
  denunciasController.adminListar
);

router.post(
  '/:id/decidir',
  verificarPermissao(['Admin']),
  denunciasController.adminDecidir
);

export default router;
