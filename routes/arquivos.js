// 📁 routes/arquivos.js
import express from 'express';
import arquivosController from '../controllers/arquivosController.js';
import { uploadPedidosMedicos, validarMagicBytesPedidosMedicos } from '../middleware/uploadArquivos.js';
import { autenticarJWT } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

// 🔒 Garante req.usuario em TODAS as rotas abaixo
router.use(autenticarJWT);

// ✅ DETALHES (JSON) — Fisio e Admin
router.get(
  '/certificados/:formacaoId/detalhes',
  verificarPermissao(['Fisioterapeuta', 'Admin']),
  arquivosController.detalhesCertificado
);

// 🖼️ THUMBNAIL — Público para formações de perfis públicos
router.get(
  '/certificados/:formacaoId/thumbnail',
  arquivosController.thumbnailCertificado
);

// ✅ VISUALIZAR (inline) — Público para formações de perfis públicos
router.get(
  '/certificados/:formacaoId/visualizar',
  arquivosController.visualizarCertificado
);

// ✅ DOWNLOAD — SOMENTE Admin
router.get(
  '/certificados/:formacaoId/download',
  verificarPermissao(['Admin']),
  arquivosController.downloadCertificado
);


// 📄 PEDIDO MÉDICO — visualizar / download
router.get(
  '/pedidos-medicos/:documentoPacienteId/visualizar',
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  arquivosController.visualizarPedidoMedico
);

router.get(
  '/pedidos-medicos/:documentoPacienteId/download',
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  arquivosController.downloadPedidoMedico
);

// 📄 UPLOAD PEDIDO MÉDICO — Paciente
router.post(
  '/pedidos-medicos/:consultaId',
  verificarPermissao(['Paciente']),
  uploadPedidosMedicos.single('arquivo'),
  validarMagicBytesPedidosMedicos,
  arquivosController.uploadPedidoMedico
);

export default router;

