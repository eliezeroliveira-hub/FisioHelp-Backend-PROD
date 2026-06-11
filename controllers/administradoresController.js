//  controllers/administradoresController.js
import administradoresService from '../services/administradoresService.js';
import adminPermissionsService from '../services/adminPermissionsService.js';

function isAuth(u) {
  return !!(u?.id && u?.tipo);
}

function isAdmin(u) {
  return String(u?.tipo || '').toLowerCase() === 'admin';
}

function statusFromErro(erro) {
  // Prefer explicit status setado pelo service
  if (erro?.httpStatus || erro?.statusCode) return erro.httpStatus || erro.statusCode;

  // Mapeia erros do SQL (THROW) para conflito quando fizer sentido
  if (erro?.number === 50001) return 409;
  if (erro?.number === 2601 || erro?.number === 2627) return 409;
  if (/já existe um administrador/i.test(String(erro?.message || ''))) return 409;

  return 500;
}

const administradoresController = {
  // GET /api/admin/administradores (Master)
  async listar(req, res) {
    try {
      const usuario = req.usuario;
      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isAdmin(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const lista = await administradoresService.listar(usuario);
      return res.json({ itens: lista });
    } catch (erro) {
      const status = statusFromErro(erro);
      return res.status(status).json({ erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  // POST /api/admin/administradores (Master)
  async criar(req, res) {
    try {
      const usuario = req.usuario;
      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isAdmin(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const admin = await administradoresService.criar(req.body, usuario);
      return res.status(201).json({ sucesso: true, admin });
    } catch (erro) {
      const status = statusFromErro(erro);
      return res.status(status).json({ erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  async listarPermissoes(req, res) {
    try {
      const usuario = req.usuario;
      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isAdmin(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const permissoes = await adminPermissionsService.listar();
      return res.json({ permissoes });
    } catch (erro) {
      const status = statusFromErro(erro);
      return res.status(status).json({ erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  async atualizarPermissoes(req, res) {
    try {
      const usuario = req.usuario;
      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isAdmin(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const permissoes = await adminPermissionsService.atualizar(
        req.body?.permissoes ?? req.body,
        usuario
      );
      return res.json({ sucesso: true, permissoes });
    } catch (erro) {
      const status = statusFromErro(erro);
      return res.status(status).json({ erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  // PUT /api/admin/administradores/me/senha
  async alterarMinhaSenha(req, res) {
    try {
      const usuario = req.usuario;
      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isAdmin(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      await administradoresService.alterarMinhaSenha(req.body, usuario);
      return res.json({ sucesso: true, mensagem: 'Senha alterada com sucesso.' });
    } catch (erro) {
      const status = statusFromErro(erro);
      return res.status(status).json({ erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  // PUT /api/admin/administradores/:id/senha (Master)
  async resetarSenha(req, res) {
    try {
      const usuario = req.usuario;
      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isAdmin(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(req.params.id);
      await administradoresService.resetarSenha(id, req.body, usuario);
      return res.json({ sucesso: true, mensagem: 'Senha redefinida com sucesso.' });
    } catch (erro) {
      const status = statusFromErro(erro);
      return res.status(status).json({ erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  // PATCH /api/admin/administradores/:id/nivel-acesso (Master)
  async alterarNivelAcesso(req, res) {
    try {
      const usuario = req.usuario;
      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isAdmin(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(req.params.id);
      const admin = await administradoresService.alterarNivelAcesso(id, req.body, usuario);
      return res.json({ sucesso: true, admin });
    } catch (erro) {
      const status = statusFromErro(erro);
      return res.status(status).json({ erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  // PATCH /api/admin/administradores/:id/ativar (Master)
  async ativar(req, res) {
    try {
      const usuario = req.usuario;
      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isAdmin(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(req.params.id);
      const r = await administradoresService.setAtivo(id, 1, usuario);
      return res.json({ sucesso: true, ...r });
    } catch (erro) {
      const status = statusFromErro(erro);
      return res.status(status).json({ erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  // PATCH /api/admin/administradores/:id/desativar (Master)
  async desativar(req, res) {
    try {
      const usuario = req.usuario;
      if (!isAuth(usuario)) return res.status(401).json({ erro: 'Não autenticado.' });
      if (!isAdmin(usuario)) return res.status(403).json({ erro: 'Acesso negado.' });

      const id = Number(req.params.id);
      const r = await administradoresService.setAtivo(id, 0, usuario);
      return res.json({ sucesso: true, ...r });
    } catch (erro) {
      const status = statusFromErro(erro);
      return res.status(status).json({ erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  }
};

export default administradoresController;
