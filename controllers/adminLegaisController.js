// 📁 controllers/adminLegaisController.js
import adminLegaisService from '../services/adminLegaisService.js';
import { HttpError } from '../utils/httpError.js';

function handleError(res, erro) {
  const status = (erro instanceof HttpError && erro.statusCode) || erro?.statusCode || 500;
  return res.status(status).json({
    sucesso: false,
    erro: status >= 500 ? 'Erro interno do servidor.' : (erro?.message || 'Erro interno.'),
    detalhes: erro?.details ?? undefined
  });
}

function requireUsuario(req, res) {
  const u = req.usuario;
  if (!u?.id || !u?.tipo) {
    res.status(401).json({ sucesso: false, erro: 'Token ausente, inválido ou expirado.' });
    return null;
  }
  return u;
}

const adminLegaisController = {
  // lista versões (rascunhos/publicados/arquivados)
  async listarVersoes(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const itens = await adminLegaisService.listarVersoes(usuario);
      return res.json({ sucesso: true, total: itens.length, itens });
    } catch (e) {
      return handleError(res, e);
    }
  },

  async ativos(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const itens = await adminLegaisService.listarAtivos(usuario);
      return res.json({ sucesso: true, total: itens.length, itens });
    } catch (e) {
      return handleError(res, e);
    }
  },

  async obterPorId(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const item = await adminLegaisService.obterPorId(usuario, { id: req.params.id });
      return res.json({ sucesso: true, item });
    } catch (e) {
      return handleError(res, e);
    }
  },

  async criarRascunho(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const out = await adminLegaisService.criarRascunho(usuario, req.body || {});
      return res.status(201).json({ sucesso: true, mensagem: 'Rascunho criado.', documento: out });
    } catch (e) {
      return handleError(res, e);
    }
  },

  async editarRascunho(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const out = await adminLegaisService.editarRascunho(usuario, { id: req.params.id, ...(req.body || {}) });
      return res.json({ sucesso: true, mensagem: 'Rascunho atualizado.', documento: out });
    } catch (e) {
      return handleError(res, e);
    }
  },

  async publicar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const out = await adminLegaisService.publicar(usuario, { id: req.params.id });
      return res.json({ sucesso: true, mensagem: 'Documento publicado e tornou-se vigente.', resultado: out });
    } catch (e) {
      return handleError(res, e);
    }
  },

  async desativar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const out = await adminLegaisService.desativar(usuario, { id: req.params.id });
      return res.json({ sucesso: true, mensagem: 'Documento legal desativado.', documento: out });
    } catch (e) {
      return handleError(res, e);
    }
  },

  async ativar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const out = await adminLegaisService.ativar(usuario, { id: req.params.id });
      return res.json({ sucesso: true, mensagem: 'Documento legal ativado.', documento: out });
    } catch (e) {
      return handleError(res, e);
    }
  },

  async excluir(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const out = await adminLegaisService.excluir(usuario, { id: req.params.id });
      return res.json({ sucesso: true, mensagem: 'Documento legal excluído.', resultado: out });
    } catch (e) {
      return handleError(res, e);
    }
  }
};

export default adminLegaisController;

