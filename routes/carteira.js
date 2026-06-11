// 📁 routes/carteira.js
import express from 'express';
import carteiraController from '../controllers/carteiraController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';
import notasFiscaisRoutes from './notasFiscais.js'; 

const router = express.Router();

router.use(autenticarJWT, requireAuth);

// ✅ Carteira
router.use('/notas-fiscais', notasFiscaisRoutes);
router.get('/dashboard', verificarPermissao(['Fisioterapeuta']), carteiraController.dashboard);
router.get('/resumo-financeiro', verificarPermissao(['Fisioterapeuta']), carteiraController.resumoFinanceiro);
router.get('/resumo-financeiro-geral', verificarPermissao(['Fisioterapeuta']), carteiraController.resumoFinanceiroGeral);
router.get('/repasses/lotes', verificarPermissao(['Fisioterapeuta']), carteiraController.repassesLotes);
router.get('/repasses', verificarPermissao(['Fisioterapeuta']), carteiraController.repasses);

export default router;
