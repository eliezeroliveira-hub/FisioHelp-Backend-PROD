// controllers/pacientesController.js
import pacientesService from '../services/pacientesService.js';
import avaliacoesService from '../services/avaliacoesService.js';
import { log } from '../config/logger.js';

function isAdmin(usuario) {
  return String(usuario?.tipo || '').toLowerCase() === 'admin';
}

function isPaciente(usuario) {
  return String(usuario?.tipo || '').toLowerCase() === 'paciente';
}

function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function toBool(value) {
  return value === true || value === 1 || value === '1';
}

function normalizarPacienteRetorno(paciente) {
  if (!paciente) return paciente;

  const cpfValido = toBool(paciente.CPFValido);
  const emailVerificado = toBool(paciente.EmailVerificado);
  const telefoneVerificado = toBool(paciente.TelefoneVerificado);

  return {
    ...paciente,
    CPFValido: cpfValido,
    EmailVerificado: emailVerificado,
    TelefoneVerificado: telefoneVerificado,
    ContaVerificada:
      paciente.ContaVerificada !== undefined
        ? toBool(paciente.ContaVerificada)
        : cpfValido && emailVerificado && telefoneVerificado,
  };
}

function ensureAuth(req, res) {
  if (!req.usuario?.id || !req.usuario?.tipo) {
    res.status(401).json({ erro: 'Token ausente, inválido ou expirado.' });
    return false;
  }
  return true;
}

function ensureOwnerOrAdmin(req, res, alvoId) {
  const u = req.usuario;
  if (isAdmin(u)) return true;
  if (isPaciente(u) && Number(u.id) === Number(alvoId)) return true;

  res.status(403).json({ erro: 'Acesso negado.' });
  return false;
}

function handleError(res, erro, fallbackStatus = 400, fallbackMsg = 'Erro na operação.') {
  const status = erro?.httpStatus || erro?.statusCode || fallbackStatus;
  return res.status(status).json({
    erro: status >= 500 ? 'Erro interno do servidor.' : fallbackMsg,
    detalhes: status >= 500 ? undefined : erro?.message
  });
}

const pacientesController = {
  async buscarPorId(req, res) {
    try {
      if (!ensureAuth(req, res)) return;

      const id = toInt(req.params.id);
      if (!id) return res.status(400).json({ erro: 'Id inválido.' });
      if (!ensureOwnerOrAdmin(req, res, id)) return;

      const pacienteRaw = await pacientesService.buscarPorId(req.usuario, id);
      const paciente = normalizarPacienteRetorno(pacienteRaw);
      if (!paciente) return res.status(404).json({ erro: 'Paciente não encontrado.' });

      const avaliacoesRecebidas = await avaliacoesService.listarMinhasAvaliacoes(req.usuario, id);
      paciente.avaliacoesRecebidas = {
        total: avaliacoesRecebidas?.total ?? 0,
        itens: avaliacoesRecebidas?.itens ?? []
      };

      return res.json(paciente);
    } catch (erro) {
      log('error', 'Erro ao buscar paciente', { erro: erro.message });
      return handleError(res, erro, 500, 'Erro ao buscar paciente.');
    }
  },

  // Cadastro é público
  async criar(req, res) {
    try {
      const novoPaciente = normalizarPacienteRetorno(await pacientesService.criar(req.body));
      log('info', 'Paciente criado', { email: novoPaciente?.Email });
      return res.status(201).json(novoPaciente);
    } catch (erro) {
      log('error', 'Erro ao criar paciente', { erro: erro.message });
      const status = erro?.httpStatus || 400;
      return res.status(status).json({
        erro: status >= 500 ? 'Erro interno do servidor.' : 'Erro ao criar paciente.',
        detalhes: status >= 500 ? undefined : erro?.message
      });
    }
  },

  async ativarPreCadastro(req, res) {
    try {
      const data = await pacientesService.ativarPreCadastro(req.body || {}, req);
      log('info', 'Pré-cadastro de paciente ativado', {
        usuarioId: data?.usuario?.id,
        email: data?.usuario?.email,
      });

      return res.status(200).json({
        sucesso: true,
        mensagem: data.mensagem || 'Pré-cadastro ativado com sucesso.',
        token: data.token,
        refreshToken: data.refreshToken,
        usuario: data.usuario,
      });
    } catch (erro) {
      log('error', 'Erro ao ativar pré-cadastro de paciente', { erro: erro.message });
      const status = erro?.httpStatus || erro?.statusCode || 500;
      const mensagem = erro?.message || 'Erro ao ativar pré-cadastro.';
      return res.status(status).json({
        erro: status >= 500 ? 'Erro interno do servidor.' : mensagem,
        detalhes: status >= 500 ? undefined : mensagem,
      });
    }
  },
  
  async solicitarVerificacaoContato(req, res) {
    try {
      if (!req.usuario) return res.status(401).json({ sucesso: false, erro: 'Não autenticado.' });

      const pacienteId = parseInt(req.params.id, 10);
      if (!Number.isInteger(pacienteId)) {
        return res.status(400).json({ sucesso: false, erro: 'PacienteId inválido.' });
      }

      // Paciente só pode operar no próprio id (Admin pode em qualquer)
      if (req.usuario.tipo === 'Paciente' && req.usuario.id !== pacienteId) {
        return res.status(403).json({ sucesso: false, erro: 'Acesso negado.' });
      }

      const body = req.body || {};
      const Canal = body.Canal ?? body.canal;
      const Destino = body.Destino ?? body.destino;
      const result = await pacientesService.solicitarVerificacaoContato(req.usuario, pacienteId, {
        Canal,
        Destino,
      });

      return res.json({ sucesso: true, ...result });
    } catch (err) {
      return res
        .status(err.httpStatus || 500)
        .json({ sucesso: false, erro: (err.httpStatus || 500) >= 500 ? 'Erro interno do servidor.' : (err.message || 'Erro na operação.') });
    }
  },


  async confirmarVerificacaoContato(req, res) {
    try {
      if (!req.usuario) return res.status(401).json({ sucesso: false, erro: 'Não autenticado.' });

      const pacienteId = parseInt(req.params.id, 10);
      if (!Number.isInteger(pacienteId)) {
        return res.status(400).json({ sucesso: false, erro: 'PacienteId inválido.' });
      }

      if (req.usuario.tipo === 'Paciente' && req.usuario.id !== pacienteId) {
        return res.status(403).json({ sucesso: false, erro: 'Acesso negado.' });
      }

      const body = req.body || {};
      const Canal = body.Canal ?? body.canal;
      const Codigo = body.Codigo ?? body.codigo;
      const result = await pacientesService.confirmarVerificacaoContato(req.usuario, pacienteId, { Canal, Codigo });

      return res.json({ sucesso: true, ...result });
    } catch (err) {
      return res
        .status(err.httpStatus || 500)
        .json({ sucesso: false, erro: (err.httpStatus || 500) >= 500 ? 'Erro interno do servidor.' : (err.message || 'Erro na operação.') });
    }
  },

async confiabilidade(req, res) {
    try {
      const usuario = req.usuario;
      const pid = Number(req.params.id);

      if (!pid) {
        return res.status(400).json({ sucesso: false, erro: 'Id inválido.' });
      }

      // Paciente só pode ver a própria confiabilidade. Admin pode consultar qualquer paciente.
      if (usuario?.tipo === 'Paciente' && Number(usuario?.id) !== pid) {
        return res.status(403).json({ sucesso: false, erro: 'Acesso negado.' });
      }

      const info = await pacientesService.obterConfiabilidade(usuario, pid);
      if (!info) return res.status(404).json({ sucesso: false, erro: 'Paciente não encontrado.' });

      return res.json(info);
    } catch (e) {
      const status = e?.httpStatus || 500;
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro interno do servidor.' : (e?.message || 'Erro ao obter confiabilidade.')
      });
    }
  },


  async atualizar(req, res) {
    try {
      if (!ensureAuth(req, res)) return;

      const id = toInt(req.params.id);
      if (!id) return res.status(400).json({ erro: 'Id inválido.' });
      if (!ensureOwnerOrAdmin(req, res, id)) return;

      const paciente = normalizarPacienteRetorno(
        await pacientesService.atualizar(req.usuario, id, req.body)
      );
      if (!paciente) return res.status(404).json({ erro: 'Paciente não encontrado.' });

      return res.json(paciente);
    } catch (erro) {
      log('error', 'Erro ao atualizar paciente', { erro: erro.message });
      return handleError(res, erro, 400, 'Erro ao atualizar paciente.');
    }
  },

  async alterarSenha(req, res) {
    try {
      if (!ensureAuth(req, res)) return;

      const id = toInt(req.params.id);
      if (!id) return res.status(400).json({ erro: 'Id inválido.' });
      if (!ensureOwnerOrAdmin(req, res, id)) return;

      const out = await pacientesService.alterarSenha(req.usuario, id, req.body || {});
      return res.json(out);
    } catch (erro) {
      log('error', 'Erro ao alterar senha', { erro: erro.message });
      return handleError(res, erro, 400, 'Erro ao alterar senha.');
    }
  },

  async remover(req, res) {
    try {
      if (!ensureAuth(req, res)) return;

      const id = toInt(req.params.id);
      if (!id) return res.status(400).json({ erro: 'Id inválido.' });
      if (!ensureOwnerOrAdmin(req, res, id)) return;

      const resultado = await pacientesService.remover(req.usuario, id, req.body || {});
      return res.json(resultado);
    } catch (erro) {
      log('error', 'Erro ao remover paciente', { erro: erro.message });
      return handleError(res, erro, 500, 'Erro ao remover paciente.');
    }
  }
};

export default pacientesController;


