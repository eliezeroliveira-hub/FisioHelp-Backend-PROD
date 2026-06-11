// 📁 controllers/carteiraController.js
import carteiraService from '../services/carteiraService.js';
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

function asTipo(u) {
  return String(u?.tipo || '').toLowerCase();
}
function isAdmin(u) {
  return asTipo(u) === 'admin';
}
function isFisio(u) {
  return asTipo(u) === 'fisioterapeuta';
}

const carteiraController = {
  /**
   * GET /carteira/dashboard
   */
  async dashboard(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const fisioterapeutaId = isAdmin(usuario) ? req.query.fisioterapeutaId : null;
      const mesReferencia = req.query.mesReferencia ?? req.query.mes ?? null;
      const dados = await carteiraService.obterDashboard(usuario, { fisioterapeutaId, mesReferencia });

      log('info', '📊 Carteira > Dashboard', {
        fonte: 'analytics.vw_FisioDashboard + dbo.Consultas (mensal/geral)',
        userId: usuario.id,
        tipo: usuario.tipo,
        alvo: fisioterapeutaId ? Number(fisioterapeutaId) : Number(usuario.id),
        mesReferencia: mesReferencia ?? undefined,
        encontrou: !!dados
      });

      return res.json({ sucesso: true, dashboard: dados });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /carteira/resumo-financeiro
   */
  async resumoFinanceiro(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const fisioterapeutaId = isAdmin(usuario) ? req.query.fisioterapeutaId : null;
      const dados = await carteiraService.obterResumoFinanceiro(usuario, { fisioterapeutaId });

      log('info', '🧾 Carteira > Resumo financeiro', {
        fonte: 'analytics.vw_FisioFinanceiroResumo',
        userId: usuario.id,
        tipo: usuario.tipo,
        alvo: fisioterapeutaId ? Number(fisioterapeutaId) : Number(usuario.id),
        encontrou: !!dados
      });

      return res.json({ sucesso: true, resumoFinanceiro: dados });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /carteira/resumo-financeiro-geral
   */
  async resumoFinanceiroGeral(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const fisioterapeutaId = isAdmin(usuario) ? req.query.fisioterapeutaId : null;
      const dados = await carteiraService.obterResumoFinanceiroGeral(usuario, { fisioterapeutaId });

      log('info', '🧾 Carteira > Resumo financeiro geral', {
        fonte: 'analytics.vw_FisioFinanceiroResumoGeral',
        userId: usuario.id,
        tipo: usuario.tipo,
        alvo: fisioterapeutaId ? Number(fisioterapeutaId) : Number(usuario.id),
        encontrou: !!dados
      });

      return res.json({ sucesso: true, resumoFinanceiroGeral: dados });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /carteira/repasses
   * - Fisio: SEMPRE próprio
   * - Admin: pode passar ?fisioterapeutaId=
   */
  async repasses(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const fisioterapeutaId = isAdmin(usuario) ? req.query.fisioterapeutaId : null;

      const resultado = await carteiraService.listarRepasses(usuario, {
        fisioterapeutaId,
        status: req.query.status,
        de: req.query.de,
        ate: req.query.ate,
        limit: req.query.limit,
        offset: req.query.offset
      });

      const itens = Array.isArray(resultado) ? resultado : (resultado?.itens || []);
      const total = Array.isArray(resultado) ? itens.length : Number(resultado?.total ?? itens.length);
      const limit = Array.isArray(resultado) ? null : resultado?.limit;
      const offset = Array.isArray(resultado) ? null : resultado?.offset;

      log('info', '💸 Carteira > Repasses', {
        fonte: 'dbo.Repasses',
        userId: usuario.id,
        tipo: usuario.tipo,
        alvo: isFisio(usuario) ? Number(usuario.id) : (fisioterapeutaId ? Number(fisioterapeutaId) : null),
        filtros: {
          status: req.query.status ?? null,
          de: req.query.de ?? null,
          ate: req.query.ate ?? null,
          limit: req.query.limit ?? null,
          offset: req.query.offset ?? null
        },
        total
      });

      return res.json({ sucesso: true, total, limit, offset, itens });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /carteira/repasses/lotes
   * Demonstrativo por lote gateway, sem alterar o endpoint legado de repasses.
   */
  async repassesLotes(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const fisioterapeutaId = isAdmin(usuario) ? req.query.fisioterapeutaId : null;

      const resultado = await carteiraService.listarLotesRepasses(usuario, {
        fisioterapeutaId,
        status: req.query.status,
        incluirHistorico: req.query.incluirHistorico,
        de: req.query.de,
        ate: req.query.ate,
        limit: req.query.limit,
        offset: req.query.offset
      });

      log('info', '💸 Carteira > Repasses por lote', {
        fonte: 'dbo.LotesRepassesGateway + dbo.LoteRepassesGatewayItens',
        userId: usuario.id,
        tipo: usuario.tipo,
        alvo: isFisio(usuario) ? Number(usuario.id) : (fisioterapeutaId ? Number(fisioterapeutaId) : null),
        filtros: {
          status: req.query.status ?? null,
          incluirHistorico: req.query.incluirHistorico ?? null,
          de: req.query.de ?? null,
          ate: req.query.ate ?? null,
          limit: req.query.limit ?? null,
          offset: req.query.offset ?? null
        },
        total: resultado?.total ?? 0,
        pendentesSemLote: resultado?.totalPendentesSemLote ?? 0
      });

      return res.json({ sucesso: true, ...resultado });
    } catch (erro) {
      return handleError(res, erro);
    }
  }
};

export default carteiraController;

