// controllers/authController.js
import jwt from 'jsonwebtoken';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { authService } from '../services/authService.js';
import { validarGoogleToken, validarAppleToken } from '../services/oauthService.js';
import redefinicaoSenhaService from '../services/redefinicaoSenhaService.js';
import { isValidCNPJ, normalizeCNPJ } from '../utils/identityValidators.js';

/* ------------------------------ helpers ------------------------------ */

function normalizeDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function statusFromAuthMessage(msg, fallback = 500) {
  const m = String(msg || '').trim();
  if (!m) return fallback;

  const ml = m.toLowerCase();

  // 400 - payload inválido
  if (ml.includes('informe') || ml.includes('obrigatório') || ml.includes('obrigatorio')) return 400;
  if (ml.includes('provedor') && ml.includes('ausente')) return 400;
  if (ml.includes('oauth') && ml.includes('ausente')) return 400;

  // 403 - conta bloqueada/inativa (ou inconsistência de cadastro)
  if (ml.includes('desativad') || ml.includes('bloquead') || ml.includes('duplicado')) return 403;

  // 401 - credenciais inválidas
  if (ml.includes('usuário não encontrado') || ml.includes('usuario não encontrado') || ml.includes('usuario nao encontrado')) return 401;
  if (ml.includes('senha incorreta')) return 401;
  if (ml.includes('refresh token')) return 401;
  if (ml.includes('token oauth inválido') || ml.includes('token oauth invalido')) return 401;
  if (ml.includes('e-mail não verificado') || ml.includes('email não verificado') || ml.includes('email nao verificado')) return 401;

  // 429 - lockout / throttling
  if (ml.includes('muitas tentativas') || ml.includes('temporariamente bloqueada')) return 429;

  // 404 - quando explicitamente indicado (ex.: OAuth "Cadastre-se")
  if (ml.includes('cadastre-se')) return 404;

  return fallback;
}

function getSqlErrorNumber(err) {
  return (
    err?.number ??
    err?.originalError?.info?.number ??
    err?.originalError?.number ??
    null
  );
}

function isSensitiveAuthInfraError(err) {
  const sqlNum = getSqlErrorNumber(err);
  const msg = String(err?.message || '').toLowerCase();
  return sqlNum === 50090 || msg.includes('loginlockouts') || msg.includes('dbo.');
}

function authErrorPayload(err, fallbackStatus = 500) {
  if (isSensitiveAuthInfraError(err)) {
    return {
      status: 500,
      body: { erro: 'Erro interno de autenticação. Contate o suporte.' }
    };
  }
  const status = err?.httpStatus || err?.statusCode || statusFromAuthMessage(err?.message, fallbackStatus);
  return {
    status,
    body: { erro: status >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro interno no login.') }
  };
}

/**
 * Preenche req.usuario (para o requestLogger enxergar o usuário autenticado
 * na própria requisição de /auth/login, /auth/login-oauth e /auth/refresh)
 *
 * Prioriza `data.usuario`. Se faltar, decodifica o `data.token` (access token),
 * usando a mesma regra do authJWT.
 */
function preencherUsuarioParaLog(req, data) {
  try {
    if (!req || req.usuario?.id) return;

    const u = data?.usuario || null;

    const id = Number(u?.id ?? u?.usuarioId ?? null);
    const tipo = u?.tipo ?? u?.tipoUsuario ?? null;

    if (id && tipo) {
      req.usuario = {
        id,
        tipo,
        email: u?.email ?? null,
        nome: u?.nome ?? null
      };
      return;
    }

    if (data?.token) {
      const decoded = jwt.verify(String(data.token), ENV.JWT_SECRET);
      const id2 = Number(decoded?.usuarioId ?? decoded?.id ?? null);
      const tipo2 = decoded?.tipoUsuario ?? decoded?.tipo ?? null;

      if (id2 && tipo2) {
        req.usuario = {
          id: id2,
          tipo: tipo2,
          email: decoded?.email ?? null,
          nome: decoded?.nome ?? null
        };
      }
    }
  } catch (_e) {
    // Não quebra login/refresh por causa do log
  }
}

/* ------------------------------ controller ------------------------------ */

const authController = {
  /**
   * Login (Admin / Fisioterapeuta / Paciente)
   *
   * Aceita:
   *  - email
   *  - cpf (11 dígitos)
   *  - cnpj (14 caracteres, numérico ou alfanumérico)
   *  - login (fallback genérico)
   */
  async login(req, res) {
    const { email, cpf, cnpj, senha, login } = req.body || {};

    const identificadorRaw = email || cpf || cnpj || login;
    if (!identificadorRaw || !senha) {
      return res.status(400).json({ erro: 'Informe usuário e senha.' });
    }

    try {
      const identificador = String(identificadorRaw).trim();
      const digits = normalizeDigits(identificador);
      const cnpjNorm = normalizeCNPJ(identificador);

      const isCPF = digits.length === 11;
      const isCNPJ = isValidCNPJ(cnpjNorm);

      const payload = { senha: String(senha) };

      if (isCPF) payload.cpf = digits;
      else if (isCNPJ) payload.cnpj = cnpjNorm;
      else payload.email = identificador;

      const data = await authService.login(payload, req);

      // Para o requestLogger logar o usuário autenticado nesta requisição
      preencherUsuarioParaLog(req, data);

      return res.status(200).json({
        sucesso: true,
        mensagem: data.mensagem || 'Login bem-sucedido.',
        token: data.token,
        refreshToken: data.refreshToken,
        usuario: data.usuario
      });
    } catch (erro) {
      log('error', ' Erro no login', { erro: erro.message });
      const out = authErrorPayload(erro, 500);
      return res.status(out.status).json(out.body);
    }
  },

  /**
   * Login OAuth (Google / Apple)
   */
  async loginOAuth(req, res) {
    const { provedor, id_token, nonce } = req.body || {};
    const prov = String(provedor || '').toLowerCase().trim();

    if (!provedor || !id_token) {
      return res.status(400).json({ erro: 'Provedor ou token ausente.' });
    }
    if (prov === 'apple' && !String(nonce || '').trim()) {
      return res.status(400).json({ erro: 'Nonce OAuth ausente.' });
    }

    try {
      let dadosOAuth;
      if (prov === 'google') dadosOAuth = await validarGoogleToken(id_token, nonce);
      else if (prov === 'apple') dadosOAuth = await validarAppleToken(id_token, nonce);
      else return res.status(400).json({ erro: 'Provedor OAuth inválido.' });

      if (!dadosOAuth?.email) {
        return res.status(401).json({ erro: 'Token OAuth inválido.' });
      }

      const data = await authService.loginOAuth(
        {
          email: dadosOAuth.email,
          nome: dadosOAuth.nome || dadosOAuth.name || null,
          emailVerificado: dadosOAuth.emailVerificado === true
        },
        req
      );

      // Para o requestLogger logar o usuário autenticado nesta requisição
      preencherUsuarioParaLog(req, data);

      return res.status(200).json({
        sucesso: true,
        mensagem: data.mensagem || `Login via ${dadosOAuth.provedor || prov} realizado com sucesso.`,
        token: data.token,
        refreshToken: data.refreshToken,
        usuario: data.usuario
      });
    } catch (erro) {
      const out = authErrorPayload(erro, 401);
      return res.status(out.status).json(out.body);
    }
  },

  /**
   * Refresh Token (Access + Refresh rotacionado)
   *
   * Body esperado:
   * { "refreshToken": "<refresh_token>" }
   *
   * (compatibilidade: se vier tokenAntigo, também tenta)
   */
  async refreshToken(req, res) {
    const refreshToken = req.body?.refreshToken || req.body?.tokenAntigo;
    if (!refreshToken) {
      return res.status(400).json({ erro: 'refreshToken não fornecido.' });
    }

    try {
      const data = await authService.refresh(refreshToken, req);

      // Para o requestLogger logar o usuário do token novo nesta requisição
      preencherUsuarioParaLog(req, data);

      return res.status(200).json({
        sucesso: true,
        mensagem: data.mensagem || 'Token renovado com sucesso.',
        token: data.token,
        refreshToken: data.refreshToken,
        usuario: data.usuario || null
      });
    } catch (erro) {
      const out = authErrorPayload(erro, 401);
      return res.status(out.status).json(out.body);
    }
  },

  async solicitarRedefinicaoSenha(req, res) {
    try {
      const data = await redefinicaoSenhaService.solicitarRedefinicaoSenha(req.body || {}, req);
      return res.status(200).json(data);
    } catch (erro) {
      log('error', 'Erro ao solicitar redefinição de senha', { erro: erro.message });
      const out = authErrorPayload(erro, 500);
      return res.status(out.status).json(out.body);
    }
  },

  async confirmarCodigoRedefinicaoSenha(req, res) {
    try {
      const data = await redefinicaoSenhaService.confirmarCodigoRedefinicaoSenha(req.body || {});
      return res.status(200).json(data);
    } catch (erro) {
      const out = authErrorPayload(erro, 400);
      return res.status(out.status).json(out.body);
    }
  },

  async redefinirSenha(req, res) {
    try {
      const data = await redefinicaoSenhaService.redefinirSenha(req.body || {});
      return res.status(200).json(data);
    } catch (erro) {
      const out = authErrorPayload(erro, 400);
      return res.status(out.status).json(out.body);
    }
  },

  /**
   * Logout
   * Body: { refreshToken?: "<refresh_token>" }
   * Header: Authorization: Bearer <access_token> (para blacklist imediata)
   */
  async logout(req, res) {
    try {
      const { refreshToken } = req.body || {};
      const auth = req.headers.authorization || '';
      const accessToken = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;

      await authService.logout({ refreshToken, accessToken });

      return res.status(200).json({ sucesso: true, mensagem: 'Logout realizado.' });
    } catch (erro) {
      const out = authErrorPayload(erro, 500);
      return res.status(out.status).json(out.body);
    }
  }
};

export default authController;
