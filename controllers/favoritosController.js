// 📁 controllers/favoritosController.js
import favoritosService from '../services/favoritosService.js';

function requireUsuario(req, res) {
  const u = req.usuario;
  if (!u?.id || !u?.tipo) {
    res.status(401).json({ sucesso: false, erro: 'Token ausente, inválido ou expirado.' });
    return null;
  }
  return u;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

export default {
  async listar(req, res) {
    try {
      const u = requireUsuario(req, res);
      if (!u) return;

      const itensRaw = await favoritosService.listar(u);

      const itens = (itensRaw || []).map((x) => ({
        FavoritoId: x?.FavoritoId ?? x?.favoritoId,
        FisioterapeutaId: x?.FisioterapeutaId ?? x?.fisioterapeutaId,
        Nome: x?.Nome ?? x?.nome,
        CREFITO: x?.CREFITO ?? x?.crefito ?? null,
        Especialidade: x?.Especialidade ?? x?.especialidade ?? null,
        FotoPerfilUrl: x?.FotoPerfilUrl ?? x?.fotoPerfilUrl ?? null,
        DataAdicionado: x?.DataAdicionado ?? x?.dataAdicionado ?? null,
      }));

      return res.json({ sucesso: true, total: itens.length, itens });
    } catch (e) {
      return res.status(500).json({ sucesso: false, erro: 'Erro interno do servidor.' });
    }
  },

  async adicionar(req, res) {
    try {
      const u = requireUsuario(req, res);
      if (!u) return;

      const fisioterapeutaId = toInt(req.body?.FisioterapeutaId ?? req.body?.fisioterapeutaId);
      if (!fisioterapeutaId) return res.status(400).json({ sucesso: false, erro: 'FisioterapeutaId inválido.' });

      const item = await favoritosService.adicionar(u, fisioterapeutaId);
      return res.status(201).json({ sucesso: true, item });
    } catch (e) {
      const status = e?.httpStatus || 500;
      return res.status(status).json({ sucesso: false, erro: status >= 500 ? 'Erro interno do servidor.' : (e?.message || '') });
    }
  },

  async removerPorFisio(req, res) {
    try {
      const u = requireUsuario(req, res);
      if (!u) return;

      const fisioterapeutaId = toInt(req.params?.fisioterapeutaId);
      if (!fisioterapeutaId) return res.status(400).json({ sucesso: false, erro: 'FisioterapeutaId inválido.' });

      await favoritosService.removerPorFisio(u, fisioterapeutaId);
      return res.json({ sucesso: true });
    } catch (e) {
      const status = e?.httpStatus || 500;
      return res.status(status).json({ sucesso: false, erro: status >= 500 ? 'Erro interno do servidor.' : (e?.message || '') });
    }
  }
};


