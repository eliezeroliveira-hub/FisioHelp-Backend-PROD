// 📁 middleware/authJWT.js
import jwt from 'jsonwebtoken';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { authService } from '../services/authService.js';

/**
 * Autenticação opcional:
 * - sem token: segue
 * - token válido e NÃO revogado: req.usuario preenchido
 * - token inválido/expirado/revogado: req.usuario = null (segue)
 */
export const autenticarJWT = async (req, _res, next) => {
  req.usuario = null;
  req.jwtErro = null;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return next();

  try {
    const decoded = jwt.verify(token, ENV.JWT_SECRET);

    // ✅ blacklist por jti (logout imediato)
    const jti = decoded?.jti || null;
    const exp = decoded?.exp || null;
    if (jti) {
      const revoked = await authService.isAccessTokenRevoked(jti, exp);
      if (revoked) {
        req.usuario = null;
        req.jwtErro = 'JwtRevoked';
        log('warn', 'Token revogado (blacklist)', { jti });
        return next();
      }
    }

    const id = Number(decoded.userId ?? decoded.id);
    const tipo = decoded.tipoUsuario ?? decoded.tipo;

    if (!id || !tipo) return next();

    req.usuario = {
      id,
      tipo,
      email: decoded.email ?? null,
      nome: decoded.nome ?? null
    };

    // útil no logout/depuração
    req.jwt = {
      jti: decoded?.jti || null,
      exp: decoded?.exp || null
    };

    return next();
  } catch (erro) {
    req.usuario = null;
    req.jwtErro = erro?.name || 'JwtError';
    log('warn', 'Token inválido ou expirado', { motivo: erro?.message });
    return next();
  }
};

/**
 * Exige autenticação de verdade:
 * - sem token / inválido / expirado / revogado: 401
 */
export const requireAuth = (req, res, next) => {
  if (!req.usuario?.id || !req.usuario?.tipo) {
    const detalhe =
      req.jwtErro === 'JwtRevoked'
        ? 'Token revogado.'
        : 'Token ausente, inválido ou expirado.';

    return res.status(401).json({ erro: detalhe });
  }
  return next();
};
