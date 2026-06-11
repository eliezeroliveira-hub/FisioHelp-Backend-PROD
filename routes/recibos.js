// 📁 routes/recibos.js
import express from 'express';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';
import recibosController from '../controllers/recibosController.js';

const router = express.Router();

router.use(autenticarJWT, requireAuth);

router.get('/', verificarPermissao(['Paciente']), recibosController.listar);
router.get('/:id', verificarPermissao(['Paciente']), recibosController.detalhar);
router.get('/:id/pdf', verificarPermissao(['Paciente']), recibosController.pdf);

export default router;
