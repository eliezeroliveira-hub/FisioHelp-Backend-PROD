// routes/pacientes.js
import express from 'express';
import pacientesController from '../controllers/pacientesController.js';
import { autenticarJWT } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';
import { requireTrustedBff } from '../middleware/trustedBff.js';
import { requireNewRegistrationsEnabled } from '../middleware/operationStatus.js';

const router = express.Router();

// Cadastro público
router.post('/', requireNewRegistrationsEnabled, pacientesController.criar);
router.post('/social', requireTrustedBff, requireNewRegistrationsEnabled, pacientesController.criarSocial);
router.post('/ativar-pre-cadastro', requireNewRegistrationsEnabled, pacientesController.ativarPreCadastro);

// A partir daqui, tudo exige autenticação (garante req.usuario)
router.use(autenticarJWT);

router.get('/me/status-verificacao', verificarPermissao(['Paciente']), pacientesController.statusVerificacaoMe);
router.get('/:id/confiabilidade', verificarPermissao(['Paciente']), pacientesController.confiabilidade);

// Verificação de contato (Email/Telefone)
router.post('/:id/contato/solicitar', verificarPermissao(['Paciente']), pacientesController.solicitarVerificacaoContato);
router.post('/:id/contato/confirmar', verificarPermissao(['Paciente']), pacientesController.confirmarVerificacaoContato);

router.get('/:id', verificarPermissao(['Paciente']), pacientesController.buscarPorId);
router.put('/:id', verificarPermissao(['Paciente']), pacientesController.atualizar);
router.put('/:id/senha', verificarPermissao(['Paciente']), pacientesController.alterarSenha);
router.delete('/:id', verificarPermissao(['Paciente']), pacientesController.remover);

export default router;
