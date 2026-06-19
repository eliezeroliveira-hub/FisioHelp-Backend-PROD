import express from 'express';
import contatoPublicoController from '../controllers/contatoPublicoController.js';
import {
  contatoPublicoEmailLimiter,
  contatoPublicoIpLimiter,
} from '../middleware/apiLimiter.js';

const router = express.Router();

router.post(
  '/',
  contatoPublicoIpLimiter,
  contatoPublicoEmailLimiter,
  contatoPublicoController.enviar
);

export default router;
