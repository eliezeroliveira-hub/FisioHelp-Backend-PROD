// 📁 routes/avaliacoes.js
import express from 'express';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';
import avaliacoesController from '../controllers/avaliacoesController.js';

const router = express.Router();

router.use(autenticarJWT, requireAuth);

// Paciente -> avalia fisioterapeuta
router.post('/fisioterapeutas', verificarPermissao(['Paciente']), avaliacoesController.avaliarFisioterapeuta);

// Paciente -> vê avaliações RECEBIDAS (fisioterapeuta -> paciente)
router.get('/minhas', verificarPermissao(['Paciente']), avaliacoesController.minhas);

// Compat: Paciente -> lista avaliações FEITAS (paciente -> fisioterapeuta)
router.get('/feitas', verificarPermissao(['Paciente']), avaliacoesController.feitas);

// Fisioterapeuta -> avalia paciente
router.post('/pacientes', verificarPermissao(['Fisioterapeuta']), avaliacoesController.avaliarPaciente);

export default router;
