// 📁 controllers/legaisController.js
import legaisService from '../services/legaisService.js';
import { HttpError } from '../utils/httpError.js';
import { log } from '../config/logger.js';
import { invalidateLegaisPendenciasCache } from '../utils/legaisPendenciasCache.js';

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

function getClientIp(req) {
  // se você usa proxy (Azure/AppGW), configure app.set('trust proxy', 1) no server.js
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip;
}

const legaisController = {
  async pendencias(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const pendencias = await legaisService.verificarPendencias(usuario);

      const temPendencia = (pendencias || []).some(p =>
        p?.Pendente === 1 || p?.Pendente === true || String(p?.Pendente).toLowerCase() === 'true'
      );

      log('info', '📜 Legais (pendencias)', { userId: usuario.id, tipo: usuario.tipo, temPendencia });

      return res.json({ sucesso: true, temPendencia, pendencias });
    } catch (e) {
      return handleError(res, e);
    }
  },

  async ativos(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      // opcional: filtrar por tipo: ?tipos=Termos,Privacidade
      const tipos = req.query.tipos ? String(req.query.tipos).split(',').map(s => s.trim()).filter(Boolean) : null;

      const docs = await legaisService.listarAtivos(usuario, { tipos });

      log('info', '📜 Legais (ativos)', { userId: usuario.id, tipo: usuario.tipo, total: docs.length });

      return res.json({ sucesso: true, documentos: docs });
    } catch (e) {
      return handleError(res, e);
    }
  },

  async aceitar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const documentoLegalId = Number(req.body?.documentoLegalId);
      const origem = String(req.body?.origem || 'App');
      const ip = getClientIp(req);
      const userAgent = String(req.get('user-agent') || '');

      const out = await legaisService.registrarAceite(usuario, {
        documentoLegalId,
        ip,
        userAgent,
        origem
      });
      invalidateLegaisPendenciasCache(usuario.id);

      log('info', '📜 Legais (aceitar)', {
        userId: usuario.id,
        tipo: usuario.tipo,
        documentoLegalId,
        origem
      });

      return res.json({ sucesso: true, resultado: out ?? null });
    } catch (e) {
      return handleError(res, e);
    }
  }
};

export default legaisController;

