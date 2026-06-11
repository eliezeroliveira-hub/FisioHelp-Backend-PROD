// 📁 routes/notasFiscais.js
import express from 'express';
import notasFiscaisController from '../controllers/notasFiscaisController.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

// GET /carteira/notas-fiscais
router.get('/', verificarPermissao(['Fisioterapeuta']), notasFiscaisController.listar);

// GET /carteira/notas-fiscais/:id
router.get('/:id', verificarPermissao(['Fisioterapeuta']), notasFiscaisController.detalhar);

// GET /carteira/notas-fiscais/:id/pdf?inline=1
router.get('/:id/pdf', verificarPermissao(['Fisioterapeuta']), notasFiscaisController.downloadPdf);

// GET /carteira/notas-fiscais/:id/xml?inline=1
router.get('/:id/xml', verificarPermissao(['Fisioterapeuta']), notasFiscaisController.downloadXml);

export default router;
