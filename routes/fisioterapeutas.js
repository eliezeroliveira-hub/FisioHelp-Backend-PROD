// 📁 routes/fisioterapeutas.js
import express from 'express';
import fisioterapeutasController from '../controllers/fisioterapeutasController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';
import uploadArquivos, { validarMagicBytesCertificados } from '../middleware/uploadArquivos.js';
import uploadFotoPerfil, { validarMagicBytesFotoPerfil } from '../middleware/uploadFotoPerfil.js';

// ⚠️ Você já criou o módulo /videos para vídeo bruto.
// Então aqui NÃO deve existir upload de vídeo usando uploadArquivos (bloqueia video/*).
// import { uploadVideoBruto } from '../middleware/uploadVideo.js';

const router = express.Router();

/**
 * Regras importantes:
 * - Rotas públicas primeiro
 * - Rotas específicas (ex.: /me, /perfil-completo, /documentos/...) ANTES de /:id
 * - Nada de permitir o fisio operar em /:id (exceto admin)
 */

// ===============
// 🌐 PÚBLICAS
// ===============

router.get('/buscar', fisioterapeutasController.buscar);
router.get('/perfil/:id', autenticarJWT, fisioterapeutasController.perfilPublico);

// 📅 Agenda (PACIENTE) — ver disponibilidade por data e calendário do mês
router.get('/:id/disponibilidade', fisioterapeutasController.disponibilidadePorData);
router.get('/:id/calendario', fisioterapeutasController.calendarioMensal);
router.post('/', fisioterapeutasController.criar);

// ==============================
// 🔐 LOGADAS (FISIOTERAPEUTA)
// ==============================

// ⭐ Perfil completo (somente o fisioterapeuta logado)
router.get(
  '/perfil-completo',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.perfilCompleto
);


// 📊 Avaliações & reputação (somente o fisioterapeuta logado)
router.get(
  '/me/avaliacoes',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.listarAvaliacoesMe
);

router.get(
  '/me/avaliacoes/media',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.minhasAvaliacoesMedia
);


// ✏️ Update genérico (/me) — pode manter por compatibilidade, mas preferir endpoints específicos abaixo
router.put(
  '/me',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.atualizarMe
);

// 🔐 Alterar senha (somente o fisioterapeuta logado)
router.put(
  '/me/senha',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.alterarSenhaMe
);


// 👤 Pré-cadastro de paciente (paciente fora da plataforma)
router.post('/pacientes/pre-cadastro',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.preCadastrarPaciente
);

// ✅ (B) Endpoints claros e validados
router.patch(
  '/me/dados',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.atualizarMeDados
);

router.patch(
  '/me/banco',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.atualizarMeBanco
);

router.put(
  '/me/banco',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.atualizarMeBanco
);

router.patch(
  '/me/preco',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.atualizarMePreco
);

router.patch(
  '/me/especialidade',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.atualizarMeEspecialidade
);

router.patch(
  '/me/cancelamento',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.atualizarMeCancelamento
);

router.patch(
  '/me/confirmacao-automatica',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.atualizarMeConfirmacaoAutomatica
);

// Fisio só pode desativar/remover a própria conta (soft delete / bloqueio)
router.post(
  '/me/desativar',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.removerMe
);

router.delete(
  '/me',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.removerMe
);

// ==================
// 📷 FOTO DE PERFIL (Opção B: Documento + FotoPerfilDocumentoId)
// ==================

router.post(
  '/foto-perfil',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  uploadFotoPerfil.single('arquivo'),
  validarMagicBytesFotoPerfil,
  fisioterapeutasController.uploadFotoPerfil
);

router.delete(
  '/foto-perfil',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.removerFotoPerfil
);

// 📄 Upload de documentos (certificados, diplomas, etc.)
router.post(
  '/documentos/upload',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  uploadArquivos.single('arquivo'),
  validarMagicBytesCertificados,
  fisioterapeutasController.uploadDocumento
);

router.patch(
  '/formacoes/:id',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.atualizarFormacao
);

router.delete(
  '/formacoes/:id',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.removerFormacao
);
// ✅ Status da validação de documentos
router.get(
  '/documentos/status',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.statusDocumento
);

// ❌ Rota antiga de vídeo aqui — REMOVIDA.
// Vídeo bruto agora é em /videos/me/video-bruto (módulo videos).

// ==================
// 🔐 ADMIN
// ==================

router.get(
  '/',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Admin']),
  fisioterapeutasController.listar
);

// Admin pode bloquear/remover qualquer fisio
router.delete(
  '/:id',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Admin']),
  fisioterapeutasController.remover
);

// ==============================
// Confiabilidade + Verificação de contato (Email/Telefone)
// ==============================
router.get(
  '/:id/confiabilidade',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.obterConfiabilidade
);

router.post(
  '/:id/contato/solicitar',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.solicitarVerificacaoContato
);

router.post(
  '/:id/contato/confirmar',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.confirmarVerificacaoContato
);

// 🏥 Especialidades do fisioterapeuta
router.get(
  '/me/especialidades',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.listarMinhasEspecialidades
);

router.put(
  '/me/especialidades',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Fisioterapeuta']),
  fisioterapeutasController.salvarMinhasEspecialidades
);

router.get(
  '/:id/especialidades',
  autenticarJWT,
  fisioterapeutasController.listarEspecialidadesPublico
);

// 👤 Fallback público — deixe por ÚLTIMO
router.get('/:id', fisioterapeutasController.buscarPorId);

export default router;

