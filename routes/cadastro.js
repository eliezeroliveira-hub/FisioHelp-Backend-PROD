import express from 'express';
import cadastroController from '../controllers/cadastroController.js';
import cadastroFisioterapeutaContatoController from '../controllers/cadastroFisioterapeutaContatoController.js';
import {
  cadastroFisioContatoIpLimiter,
  cadastroFisioEmailLimiter,
  cadastroFisioTelefoneLimiter,
} from '../middleware/apiLimiter.js';

const router = express.Router();

router.get('/verificar', cadastroController.verificar);

router.use('/fisioterapeuta', cadastroFisioContatoIpLimiter);
router.post(
  '/fisioterapeuta/email/solicitar',
  cadastroFisioEmailLimiter,
  cadastroFisioterapeutaContatoController.solicitarEmail
);
router.post('/fisioterapeuta/email/confirmar', cadastroFisioterapeutaContatoController.confirmarEmail);
router.post(
  '/fisioterapeuta/telefone/solicitar',
  cadastroFisioTelefoneLimiter,
  cadastroFisioterapeutaContatoController.solicitarTelefone
);
router.post('/fisioterapeuta/telefone/confirmar', cadastroFisioterapeutaContatoController.confirmarTelefone);
router.post('/fisioterapeuta/contato/status', cadastroFisioterapeutaContatoController.status);

export default router;
