import express from 'express';
import cadastroController from '../controllers/cadastroController.js';

const router = express.Router();

router.get('/verificar', cadastroController.verificar);

export default router;
