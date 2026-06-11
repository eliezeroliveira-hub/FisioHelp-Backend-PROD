// 📁 routes/favoritos.js
import express from 'express';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';
import favoritosController from '../controllers/favoritosController.js';

const router = express.Router();

router.use(autenticarJWT, requireAuth);

router.get('/', verificarPermissao(['Paciente']), favoritosController.listar);
router.post('/', verificarPermissao(['Paciente']), favoritosController.adicionar);
router.delete('/fisio/:fisioterapeutaId', verificarPermissao(['Paciente']), favoritosController.removerPorFisio);

export default router;
