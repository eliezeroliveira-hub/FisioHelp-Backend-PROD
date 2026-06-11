import express from 'express';
import especialidadesController from '../controllers/especialidadesController.js';

const router = express.Router();

// Acessível ao público (sem login)
router.get('/', especialidadesController.listar);

export default router;
