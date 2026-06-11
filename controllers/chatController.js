// 📁 controllers/chatController.js
import chatService from '../services/chatService.js';
import { HttpError } from '../utils/httpError.js';

function toBool(value) {
  return value === true || value === 1 || value === '1';
}

function handleError(res, erro) {
  const status =
    (erro instanceof HttpError && erro.statusCode) ||
    erro?.statusCode ||
    erro?.codigo ||
    500;

  return res.status(status).json({
    erro: status >= 500 ? 'Erro interno do servidor.' : (erro?.message || 'Erro interno.'),
    detalhes: erro?.details ?? erro?.detalhes ?? undefined
  });
}

const chatController = {
  // GET /chat/conversas
  async listarConversas(req, res) {
    try {
      const dados = await chatService.listarConversas(req.usuario, {
        limit: req.query.limit,
        offset: req.query.offset,
        incluirNaoLiberado: req.query.incluirNaoLiberado
      });

      // ✅ Saída enxuta e igual para Paciente e Fisioterapeuta (e também Admin, se usar este endpoint)
      const itens = (dados || []).map((c) => ({
        ConsultaId: c.ConsultaId,
        DataHora: c.DataHora ?? null,
        Status: c.Status,
        ChatLiberado: !!c.ChatLiberado,
        ChatLiberadoEm: c.ChatLiberadoEm ?? null,
        OutroId: c.OutroId ?? null,
        OutroNome: c.OutroNome ?? null,
        OutroFotoUrl: c.OutroFotoUrl ?? null,
        OutroContaVerificada: toBool(c.OutroContaVerificada),
        PacienteNome: c.PacienteNome ?? null,
        FisioterapeutaNome: c.FisioterapeutaNome ?? null,
        CrefitoVerificado: toBool(c.CrefitoVerificado),
        EmailVerificado: toBool(c.EmailVerificado),
        TelefoneVerificado: toBool(c.TelefoneVerificado),
        FisioterapeutaFotoUrl: c.FisioterapeutaFotoUrl ?? null,
        UltimaMensagemId: c.UltimaMensagemId ?? null,
        UltimaMensagem: c.UltimaMensagem ?? null,
        UltimaMensagemEm: c.UltimaMensagemEm ?? null,
        UltimaMensagemRemetenteId: c.UltimaMensagemRemetenteId ?? null,
        UltimaMensagemTipoRemetente: c.UltimaMensagemTipoRemetente ?? null,
        NaoLidas: Number(c.NaoLidas ?? 0) || 0,
      }));

      return res.json(itens);
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  // GET /chat/conversas/:consultaId/mensagens
  async listarMensagens(req, res) {
    try {
      const dados = await chatService.listarMensagens(req.usuario, req.params.consultaId, {
        limit: req.query.limit,
        offset: req.query.offset
      });
      return res.json(dados);
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  // POST /chat/mensagens
  async enviarMensagem(req, res) {
    try {
      const payload = { ...(req.body || {}) };

      // Aceita chaves em camelCase ou PascalCase (compatibilidade com collections antigas)
      if (payload.consultaId === undefined && payload.ConsultaId !== undefined) payload.consultaId = payload.ConsultaId;
      if (payload.documentoPacienteId === undefined && payload.DocumentoPacienteId !== undefined) payload.documentoPacienteId = payload.DocumentoPacienteId;
      if (payload.conteudo === undefined && payload.Conteudo !== undefined) payload.conteudo = payload.Conteudo;

      const result = await chatService.enviarMensagem(req.usuario, payload);
      return res.status(201).json(result);
    } catch (erro) {
      return handleError(res, erro);
    }
  }
};

export default chatController;

