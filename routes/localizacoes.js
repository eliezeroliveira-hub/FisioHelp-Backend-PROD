// 📁 routes/localizacoes.js
import { Router } from 'express';
import localizacoesController from '../controllers/localizacoesController.js';

import { autenticarJWT } from '../middleware/authJWT.js';   // ✅ named export
import verificarPermissao from '../middleware/verificarPermissao.js'; // ✅ default export

const router = Router();

// 🔒 Garante req.usuario em TODAS as rotas abaixo
router.use(autenticarJWT);

// Consultas > Localizações (Fisio)
router.put('/minha', verificarPermissao(['Fisioterapeuta']), localizacoesController.putMinha);
router.get('/minha', verificarPermissao(['Fisioterapeuta']), localizacoesController.getMinha);

// (Opcional) Paciente: achar fisios próximos
router.get('/fisios-proximos', verificarPermissao(['Paciente']), localizacoesController.getFisiosProximos);

export default router;
