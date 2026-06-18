import express from 'express';
import notificacoesController from '../controllers/notificacoesController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';
import { ENV } from '../config/env.js';

const router = express.Router();

function bloquearRotaTesteEmProducao(_req, res, next) {
  if (String(ENV.NODE_ENV || '').toLowerCase() === 'production') {
    return res.status(404).json({ erro: 'Rota não disponível.' });
  }

  return next();
}

router.post(
  '/teste-whatsapp',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Admin']),
  bloquearRotaTesteEmProducao,
  notificacoesController.testeWhatsapp
);

router.use(autenticarJWT, requireAuth, verificarPermissao(['Paciente', 'Fisioterapeuta']));

router.post('/dispositivos', notificacoesController.registrarDispositivo);
router.delete('/dispositivos', notificacoesController.desativarDispositivo);

export default router;
