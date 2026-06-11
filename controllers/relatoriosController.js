// 📁 controllers/relatoriosController.js
import relatoriosService from '../services/relatoriosService.js';
import { HttpError } from '../utils/httpError.js';
import { log } from '../config/logger.js';

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

function requireUsuario(req, res) {
  const usuario = req.usuario;
  if (!usuario?.id || !usuario?.tipo) {
    res.status(401).json({ sucesso: false, erro: 'Token ausente, inválido ou expirado.' });
    return null;
  }
  return usuario;
}

function isTipo(usuario, tipo) {
  return String(usuario?.tipo || '').toLowerCase() === String(tipo).toLowerCase();
}

const relatoriosController = {
  /**
   * GET /relatorios/pontuacao
   * - Fisioterapeuta: retorna somente o próprio
   * - Admin: opcional ?fisioterapeutaId=123 (senão lista todos)
   */
  async pontuacao(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const fisioterapeutaId = req.query?.fisioterapeutaId ?? req.query?.FisioterapeutaId ?? null;

      const dados = await relatoriosService.pontuacao(usuario, {
        fisioterapeutaId: isTipo(usuario, 'Admin') ? fisioterapeutaId : null
      });

      log('info', '📊 Relatório de pontuação consultado', {
        userId: usuario.id,
        tipo: usuario.tipo,
        fisioterapeutaId: fisioterapeutaId ? Number(fisioterapeutaId) : undefined
      });

      return res.json({ sucesso: true, dados });
    } catch (erro) {
      return handleError(res, erro);
    }
  }
};

export default relatoriosController;

