import express from 'express';
import notificacoesController from '../controllers/notificacoesController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

router.use(autenticarJWT, requireAuth, verificarPermissao(['Paciente', 'Fisioterapeuta']));

router.post('/dispositivos', notificacoesController.registrarDispositivo);
router.delete('/dispositivos', notificacoesController.desativarDispositivo);

export default router;
