// 📁 routes/legais.js
import express from 'express';
import legaisController from '../controllers/legaisController.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

// Tudo autenticado (o index já garante autenticarJWT + requireAuth)
router.get('/pendencias', verificarPermissao(['Paciente', 'Fisioterapeuta']), legaisController.pendencias);
router.get('/ativos', verificarPermissao(['Paciente', 'Fisioterapeuta']), legaisController.ativos);
router.post('/aceitar', verificarPermissao(['Paciente', 'Fisioterapeuta']), legaisController.aceitar);

export default router;

