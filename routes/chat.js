// 📁 routes/chat.js
import express from 'express';
import chatController from '../controllers/chatController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';


// Normaliza payload do chat sem alterar regras de negócio
const normalizeChatBody = (req, _res, next) => {
  const b = req.body && typeof req.body === 'object' ? { ...req.body } : {};

  // Aceita variações de casing/nome vindas do Postman/frontend
  if (b.consultaId != null && b.ConsultaId == null) b.ConsultaId = b.consultaId;
  if (b.documentoPacienteId != null && b.DocumentoPacienteId == null) {
    b.DocumentoPacienteId = b.documentoPacienteId;
  }
  if (b.conteudo != null && b.Conteudo == null) b.Conteudo = b.conteudo;

  // Trim seguro (não muda lógica de autorização/regras)
  if (typeof b.Conteudo === 'string') b.Conteudo = b.Conteudo.trim();

  req.body = b;
  next();
};


const router = express.Router();

router.use(autenticarJWT, requireAuth);

router.get(
  '/conversas',
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  chatController.listarConversas
);

router.get(
  '/conversas/:consultaId/mensagens',
  verificarPermissao(['Paciente', 'Fisioterapeuta']),
  chatController.listarMensagens
);

router.post(
  '/mensagens',
  verificarPermissao(['Paciente', 'Fisioterapeuta']), // (MVP) sem Admin
  normalizeChatBody,
  chatController.enviarMensagem
);

export default router;
