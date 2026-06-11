// 📁 routes/videos.js
import express from 'express';
import { autenticarJWT } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';
import videosController from '../controllers/videosController.js';
import { uploadVideoBruto, validarMagicBytesVideoBruto } from '../middleware/uploadVideo.js';

const router = express.Router();

// 🔒 garante req.usuario em TODAS as rotas abaixo
router.use(autenticarJWT);

// POST /videos/me/video-bruto (form-data: video=<arquivo>)
router.post(
  '/me/video-bruto',
  verificarPermissao(['Fisioterapeuta']),
  uploadVideoBruto.single('video'),
  validarMagicBytesVideoBruto,
  videosController.uploadVideoBruto
);

// GET /videos/me/video-bruto (lista meus envios)
router.get(
  '/me/video-bruto',
  verificarPermissao(['Fisioterapeuta']),
  videosController.listarMeusVideosBrutos
);

// GET /videos/me/video-bruto/:documentoId/visualizar (stream inline, sem download)
router.get(
  '/me/video-bruto/:documentoId/visualizar',
  verificarPermissao(['Fisioterapeuta']),
  videosController.visualizarMeuVideoBruto
);

export default router;

