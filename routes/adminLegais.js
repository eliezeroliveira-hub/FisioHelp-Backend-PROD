// 📁 routes/adminLegais.js
import express from 'express';
import adminLegaisController from '../controllers/adminLegaisController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

router.use(autenticarJWT, requireAuth, verificarPermissao(['Admin']));

router.get('/', adminLegaisController.listarVersoes);
router.get('/ativos', adminLegaisController.ativos);
router.get('/:id', adminLegaisController.obterPorId);
router.post('/', adminLegaisController.criarRascunho);
router.put('/:id', adminLegaisController.editarRascunho);
router.post('/:id/publicar', adminLegaisController.publicar);
router.post('/:id/ativar', adminLegaisController.ativar);
router.post('/:id/desativar', adminLegaisController.desativar);
router.delete('/:id', adminLegaisController.excluir);

export default router;
