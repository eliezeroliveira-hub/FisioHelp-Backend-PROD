import express from 'express';
import cadastroController from '../controllers/cadastroController.js';
import cadastroFisioterapeutaContatoController from '../controllers/cadastroFisioterapeutaContatoController.js';
import cadastroPacienteContatoController from '../controllers/cadastroPacienteContatoController.js';
import {
  cadastroFisioContatoIpLimiter,
  cadastroFisioEmailLimiter,
  cadastroFisioTelefoneLimiter,
  cadastroPacienteContatoIpLimiter,
  cadastroPacienteEmailLimiter,
  cadastroPacienteTelefoneLimiter,
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

router.use('/paciente', cadastroPacienteContatoIpLimiter);
router.post(
  '/paciente/email/solicitar',
  cadastroPacienteEmailLimiter,
  cadastroPacienteContatoController.solicitarEmail
);
router.post('/paciente/email/confirmar', cadastroPacienteContatoController.confirmarEmail);
router.post(
  '/paciente/telefone/solicitar',
  cadastroPacienteTelefoneLimiter,
  cadastroPacienteContatoController.solicitarTelefone
);
router.post('/paciente/telefone/confirmar', cadastroPacienteContatoController.confirmarTelefone);
router.post('/paciente/contato/status', cadastroPacienteContatoController.status);

export default router;
