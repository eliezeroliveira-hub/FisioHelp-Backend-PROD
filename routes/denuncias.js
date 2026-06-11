// routes/denuncias.js
import express from 'express';
import denunciasController from '../controllers/denunciasController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

router.use(autenticarJWT, requireAuth);

router.get(
  '/categorias',
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  denunciasController.categorias
);

router.post(
  '/',
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  denunciasController.criar
);

export default router;
