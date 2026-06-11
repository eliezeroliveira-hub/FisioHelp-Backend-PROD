// routes/suporteRoutes.js
import express from 'express';
import suporteController from '../controllers/suporteController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import { uploadFaleConoscoAnexos, validarMagicBytesFaleConoscoAnexos } from '../middleware/uploadArquivos.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

// Todas as rotas aqui exigem login
router.use(autenticarJWT, requireAuth);

// Paciente abre contestação (Suporte / 30 dias)
// POST /api/Suporte/disputas
// multipart/form-data:
// - consultaId, categoriaId (opcional), descricao, opcaoReembolso ('Credito'|'Reembolso'), motivoDisputa (opcional)
// - anexos[] (0..N)
router.post(
  '/disputas',
  verificarPermissao(['Paciente']),
  uploadFaleConoscoAnexos.array('anexos', 5),
  validarMagicBytesFaleConoscoAnexos,
  suporteController.abrirDisputa
);

// Paciente ou Fisioterapeuta abre chamado geral (Suporte / Fale Conosco)
// POST /api/Suporte/chamados
// multipart/form-data:
// - descricao, categoriaId (opcional), categoriaNome (opcional), consultaId (opcional)
// - anexos[] (0..N)
router.post(
  '/chamados',
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  uploadFaleConoscoAnexos.array('anexos', 5),
  validarMagicBytesFaleConoscoAnexos,
  suporteController.abrirChamadoGeral
);

// Admin - listar chamados (filtro por id/status)
router.get(
  '/chamados',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Admin']),
  suporteController.listarChamadosAdmin
);

router.get(
  '/chamados/:id/anexos/:anexoId/download',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Admin']),
  suporteController.baixarAnexoChamadoAdmin
);

// Admin atualiza status do chamado (valida CK_FC_Status no service)
router.patch(
  '/chamados/:id/status',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Admin']),
  suporteController.atualizarStatusChamadoAdmin
);

// Paciente ou Fisioterapeuta: listar somente os seus chamados (filtro opcional por chamadoId/status)
router.get(
  '/me/chamados',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  suporteController.listarMeusChamados
);

export default router;
