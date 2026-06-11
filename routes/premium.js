// 📁 routes/premium.js
import express from 'express';
import premiumController from '../controllers/premiumController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

router.use(autenticarJWT, requireAuth);

// Fisio: consulta do próprio status premium
router.get(
  '/',
  verificarPermissao(['Fisioterapeuta']),
  premiumController.me
);

// (Opcional) Admin consulta premium de qualquer fisio
router.get(
  '/admin/:fisioterapeutaId',
  verificarPermissao(['Admin']),
  premiumController.porFisio
);

export default router;
