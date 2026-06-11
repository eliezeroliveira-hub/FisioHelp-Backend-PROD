// 📁 controllers/indicadoresController.js
import indicadoresService from '../services/indicadoresService.js';
import { HttpError } from '../utils/httpError.js';

function handleError(res, erro) {
  const status =
    (erro instanceof HttpError && erro.statusCode) ||
    erro?.statusCode ||
    erro?.codigo ||
    500;

  return res.status(status).json({
    erro: status >= 500 ? 'Erro interno do servidor.' : (erro?.message || 'Erro interno.'),
    detalhes: status >= 500 ? undefined : (erro?.details ?? undefined),
  });
}

const indicadoresController = {
  /**
   * GET /fisio/indicadores
   * (Admin opcional) ?fisioterapeutaId=123
   */
  async obter(req, res) {
    try {
      const usuario = req.usuario;
      const data = await indicadoresService.obterIndicadores(usuario, {
        fisioterapeutaId: req.query?.fisioterapeutaId,
      });

      return res.json({
        sucesso: true,
        ...data,
      });
    } catch (erro) {
      return handleError(res, erro);
    }
  },
};

export default indicadoresController;

