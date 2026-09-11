import express from 'express';
import seoPublicoController from '../controllers/seoPublicoController.js';

const router = express.Router();

router.get('/fisioterapeutas', seoPublicoController.listarFisioterapeutas);

export default router;
