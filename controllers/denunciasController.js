// controllers/denunciasController.js
import denunciasService from '../services/denunciasService.js';
import { HttpError } from '../utils/httpError.js';
import { log } from '../config/logger.js';

function handleError(res, erro, fallbackMessage) {
  const status =
    (erro instanceof HttpError && erro.statusCode) ||
    erro?.statusCode ||
    erro?.codigo ||
    500;

  return res.status(status).json({
    sucesso: false,
    erro: status >= 500 ? 'Erro interno do servidor.' : (erro?.message || fallbackMessage || 'Erro interno.'),
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

const denunciasController = {
  async categorias(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const itens = await denunciasService.listarCategorias(usuario);

      return res.json({
        sucesso: true,
        total: itens.length,
        itens
      });
    } catch (erro) {
      log('error', 'Erro ao listar categorias de denúncia', { erro: erro.message });
      return handleError(res, erro, 'Falha ao listar categorias.');
    }
  },

  async criar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const { denuncia, ultimaConsultaId, categoria } = await denunciasService.criar(req.body, usuario);

      log('info', 'Denúncia criada', {
        userId: usuario.id,
        tipo: usuario.tipo,
        denunciaId: denuncia?.Id ?? null,
        ultimaConsultaId,
        motivo: categoria?.Codigo ?? req.body?.motivo ?? null
      });

      return res.json({
        sucesso: true,
        denuncia: {
          MotivoTitulo: denuncia?.MotivoTitulo ?? null,
          MotivoDefinicao: denuncia?.MotivoDefinicao ?? null,
          Descricao: denuncia?.Descricao ?? null,
          Status: denuncia?.Status ?? null,
          CriadoEm: denuncia?.CriadoEm ?? null
        },
        ultimaConsultaId,
        categoria: {
          Titulo: categoria?.Titulo ?? denuncia?.MotivoTitulo ?? null,
          Definicao: categoria?.Definicao ?? denuncia?.MotivoDefinicao ?? null
        }
      });

    } catch (erro) {
      log('error', 'Erro ao criar denúncia', { erro: erro.message });
      return handleError(res, erro, 'Falha ao criar denúncia.');
    }
  },

  async adminListar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const lista = await denunciasService.adminListar(req.query, usuario);

      return res.json({
        sucesso: true,
        total: lista?.total ?? 0,
        limit: lista?.limit ?? 50,
        offset: lista?.offset ?? 0,
        itens: lista?.itens ?? []
      });
    } catch (erro) {
      log('error', 'Erro ao listar denúncias (admin)', { erro: erro.message });
      return handleError(res, erro, 'Falha ao listar denúncias.');
    }
  },

  async adminDecidir(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const denuncia = await denunciasService.adminDecidir(req.params.id, req.body, usuario);

      return res.json({
        sucesso: true,
        denuncia: {
          Id: denuncia?.Id ?? null,
          Status: denuncia?.Status ?? null,
          CriadoEm: denuncia?.CriadoEm ?? null,
          ResolvidoEm: denuncia?.ResolvidoEm ?? null,
          ObservacoesAdmin: denuncia?.ObservacoesAdmin ?? null
        }
      });
    } catch (erro) {
      log('error', 'Erro ao decidir denúncia (admin)', { erro: erro.message });
      return handleError(res, erro, 'Falha ao decidir denúncia.');
    }
  }
};

export default denunciasController;

