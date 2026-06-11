import express from 'express';
import parametrosSistemaController from '../controllers/parametrosSistemaController.js';

const router = express.Router();

router.get('/valor-minimo-consulta', parametrosSistemaController.obterValorMinimoConsulta);
router.get('/taxa-intermediacao', parametrosSistemaController.obterTaxaIntermediacao);
router.get('/bancos', parametrosSistemaController.obterBancos);

export default router;
