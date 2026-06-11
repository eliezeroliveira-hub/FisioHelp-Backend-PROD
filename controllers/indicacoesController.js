// 📁 controllers/indicacoesController.js
import indicacoesService from '../services/indicacoesService.js';
import { HttpError } from '../utils/httpError.js';

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

const indicacoesController = {
  // GET /indicacoes/minhas
  async minhas(req, res) {
    try {
      const data = await indicacoesService.listarMinhas(req.usuario, {
        limit: req.query.limit,
        offset: req.query.offset,
        status: req.query.status,
        indicadorId: req.query.indicadorId // apenas admin deve usar
      });
      return res.json(data);
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  // GET /indicacoes/meu-codigo
  async meuCodigo(req, res) {
    try {
      const data = await indicacoesService.meuCodigo(req.usuario);
      return res.json(data);
    } catch (erro) {
      return handleError(res, erro);
    }
  }
};

export default indicacoesController;

