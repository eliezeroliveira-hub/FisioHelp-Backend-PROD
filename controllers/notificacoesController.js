import notificacoesService from '../services/notificacoesService.js';
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

const notificacoesController = {
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
