// 📁 controllers/premiumController.js
import premiumService from '../services/premiumService.js';
import { HttpError } from '../utils/httpError.js';
import { log } from '../config/logger.js';

function handleError(res, erro) {
  const status =
    (erro instanceof HttpError && erro.statusCode) ||
    erro?.statusCode ||
    erro?.codigo ||
    500;

  return res.status(status).json({
    erro: status >= 500 ? 'Erro interno do servidor.' : (erro?.message || 'Erro interno.'),
    detalhes: status >= 500 ? undefined : (erro?.details ?? erro?.detalhes ?? undefined),
  });
}

const premiumController = {
  // GET /fisio/premium
  async me(req, res) {
    try {
      const usuario = req.usuario;
      const data = await premiumService.statusMe(usuario);

      log('info', '⭐ Premium status consultado', { userId: usuario?.id, tipo: usuario?.tipo });
      return res.json(data);
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  // GET /fisio/premium/admin/:fisioterapeutaId
  async porFisio(req, res) {
    try {
      const usuario = req.usuario;
      const data = await premiumService.statusPorFisio(req.params.fisioterapeutaId, usuario);
      return res.json(data);
    } catch (erro) {
      return handleError(res, erro);
    }
  },
};

export default premiumController;

