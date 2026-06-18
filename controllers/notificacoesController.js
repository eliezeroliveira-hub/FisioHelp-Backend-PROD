import notificacoesService from '../services/notificacoesService.js';
import whatsappProvider from '../providers/whatsappProvider.js';
import { HttpError } from '../utils/httpError.js';

function handleError(res, erro) {
  const status =
    (erro instanceof HttpError && erro.statusCode) ||
    erro?.statusCode ||
    erro?.codigo ||
    500;

  return res.status(status).json({
    sucesso: false,
    erro: status >= 500 ? 'Erro interno do servidor.' : (erro?.message || 'Erro interno.'),
    detalhes: erro?.details ?? erro?.detalhes ?? undefined
  });
}

function getUsuarioLogado(req) {
  const usuario = req.usuario;
  if (!usuario?.id || !usuario?.tipo) {
    throw new HttpError(401, 'Token ausente, inválido ou expirado.');
  }
  return usuario;
}

function statusHttpResultadoProvider(resultado) {
  if (resultado === 'sucesso') return 200;
  if (resultado === 'invalido') return 400;
  if (resultado === 'tempFalha') return 503;
  return 500;
}

const notificacoesController = {
  async testeWhatsapp(req, res) {
    try {
      getUsuarioLogado(req);

      const destinatario = String(req.body?.destinatario || '').trim();
      const mensagem = String(req.body?.mensagem || '').trim();

      if (!destinatario) {
        throw new HttpError(400, 'Destinatário de WhatsApp não informado.');
      }

      if (!mensagem) {
        throw new HttpError(400, 'Mensagem de WhatsApp não informada.');
      }

      const resultado = await whatsappProvider.enviarWhatsApp({
        destinatario,
        mensagem,
      });

      const status = statusHttpResultadoProvider(resultado?.resultado);

      return res.status(status).json({
        sucesso: resultado?.resultado === 'sucesso',
        provider: 'whatsapp',
        destinatario: whatsappProvider.mascararWhatsApp(destinatario),
        resultado: resultado?.resultado,
        messageId: resultado?.messageId ?? null,
        erro: resultado?.erro ?? null,
      });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  async registrarDispositivo(req, res) {
    try {
      const usuario = getUsuarioLogado(req);
      const resultado = await notificacoesService.registrarDispositivo(req.body || {}, usuario);

      return res.status(200).json({
        sucesso: true,
        dispositivo: resultado
      });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  async desativarDispositivo(req, res) {
    try {
      const usuario = getUsuarioLogado(req);
      await notificacoesService.desativarDispositivo(req.body || {}, usuario);

      return res.status(200).json({
        sucesso: true,
        ativo: false
      });
    } catch (erro) {
      return handleError(res, erro);
    }
  }
};

export default notificacoesController;
