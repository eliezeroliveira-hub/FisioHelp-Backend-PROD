// 📁 routes/consultas.js
import express from 'express';
import consultasController from '../controllers/consultasController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';
import { uploadEvidenciaCheckin, validarMagicBytesEvidenciaCheckin } from '../middleware/uploadArquivos.js';
import fileStorageProvider from '../providers/fileStorageProvider.js';
import {
  requireNewAppointmentsEnabled,
  requireNewContractsEnabled,
} from '../middleware/operationStatus.js';

const router = express.Router();

router.use(autenticarJWT, requireAuth);

/* ---------------- ADMIN (antes de :id) ---------------- */
router.get(
  '/admin/fisio/:id',
  verificarPermissao(['Admin']),
  consultasController.listarPorFisioterapeuta
);

router.get(
  '/admin/paciente/:id',
  verificarPermissao(['Admin']),
  consultasController.listarPorPaciente
);

/* ---------------- Consultas > Resumo/Performance ---------------- */
router.get(
  '/resumo',
  verificarPermissao(['Fisioterapeuta']),
  consultasController.resumo
);

router.get(
  '/performance',
  verificarPermissao(['Fisioterapeuta']),
  consultasController.performance
);

/* ---------------- Minhas ---------------- */
router.get(
  '/minhas',
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  consultasController.minhas
);

router.post(
  '/pre-agendamento/opcoes-pagamento',
  verificarPermissao(['Paciente']),
  requireNewAppointmentsEnabled,
  requireNewContractsEnabled,
  consultasController.opcoesPagamentoPreAgendamento
);

router.post(
  '/agendar-com-pagamento',
  verificarPermissao(['Paciente']),
  requireNewAppointmentsEnabled,
  requireNewContractsEnabled,
  consultasController.criarEPagar
);

/* ---------------- Criar ---------------- */
router.post(
  '/',
  verificarPermissao(['Paciente']),
  requireNewAppointmentsEnabled,
  consultasController.criar
);

/* ---------------- Detalhe ---------------- */
router.get(
  '/:id/termo-consentimento/pdf',
  verificarPermissao(['Fisioterapeuta']),
  consultasController.gerarTermoConsentimento
);

router.get(
  '/:id',
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  consultasController.buscarPorId
);

/* ---------------- Ações ---------------- */
router.post(
  '/:id/confirmar',
  verificarPermissao(['Fisioterapeuta']),
  consultasController.confirmar
);

router.post(
  '/:id/cancelar',
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  consultasController.cancelar
);

// Reagendamento (Paciente)
router.post(
  '/:id/reagendar',
  verificarPermissao(['Paciente']),
  requireNewAppointmentsEnabled,
  consultasController.reagendar
);

// Cancelamento por arrependimento (7 dias) (Paciente)
router.post(
  '/:id/cancelar-arrependimento-7-dias',
  verificarPermissao(['Paciente']),
  consultasController.cancelarArrependimento7Dias
);

// No-show do Fisioterapeuta (Paciente)
router.get(
  '/:id/opcoes-no-show-fisio',
  verificarPermissao(['Paciente']),
  consultasController.opcoesNoShowFisio
);

router.post(
  '/:id/no-show-fisio/decidir',
  verificarPermissao(['Paciente']),
  consultasController.decidirNoShowFisio
);

router.get(
  '/:id/opcoes-pagamento',
  verificarPermissao(['Paciente']),
  requireNewContractsEnabled,
  consultasController.opcoesPagamento
);

router.post(
  '/:id/pagar-fora-plataforma',
  verificarPermissao(['Paciente']),
  requireNewContractsEnabled,
  consultasController.marcarPagaForaPlataforma
);

router.post(
  '/:id/pagar-com-creditos',
  verificarPermissao(['Paciente']),
  requireNewContractsEnabled,
  consultasController.pagarComCreditoCarteira
);

router.post(
  '/:id/pagar-com-pacote',
  verificarPermissao(['Paciente']),
  requireNewContractsEnabled,
  consultasController.pagarComPacote
);

router.post(
  '/:id/reenviar-token',
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  consultasController.reenviarTokenValidacao
);

router.get(
  '/:id/token',
  verificarPermissao(['Paciente']),
  consultasController.token
);

router.post(
  '/:id/validar-token',
  verificarPermissao(['Fisioterapeuta']),
  consultasController.validarToken
);

router.patch(
  '/:id/observacoes',
  verificarPermissao(['Fisioterapeuta']),
  consultasController.observacoes
);

router.post(
  '/:id/comparecimento',
  verificarPermissao(['Fisioterapeuta']),
  // Opcional: evidência (1 foto) do check-in.
  // Envie como multipart/form-data, campo do arquivo: "arquivo".
  uploadEvidenciaCheckin.single('arquivo'),
  validarMagicBytesEvidenciaCheckin,
  async (req, _res, next) => {
    try {
      if (req?.file?.filename) {
        const rel = `checkin/${req.file.filename}`;
        await fileStorageProvider.uploadFile(rel, req.file.path, {
          contentType: req.file.mimetype,
          cacheControl: 'no-store',
        });
        if (fileStorageProvider.isAzureBlobStorageEnabled) {
          await fileStorageProvider.cleanupLocalTempFile(req.file.path);
        }

        // Compatibilidade com service: ele lê "evidenciaUrl" e/ou "EvidenciaCheckin".
        req.body = req.body || {};
        if (!req.body.EvidenciaCheckin) req.body.EvidenciaCheckin = rel;
        if (!req.body.evidenciaUrl) req.body.evidenciaUrl = rel;
      }
      next();
    } catch (err) {
      if (fileStorageProvider.isAzureBlobStorageEnabled) {
        await fileStorageProvider.cleanupLocalTempFile(req?.file?.path).catch(() => {});
      }
      next(err);
    }
  },
  consultasController.comparecimento
);

export default router;

