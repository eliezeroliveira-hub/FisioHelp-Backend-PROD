import rateLimit from 'express-rate-limit';
import { rateLimitKeyByIp } from '../utils/clientIp.js';

const quinzeMinutos = 15 * 60 * 1000;

function message(max) {
  return {
    erro: `Muitas solicitações de redefinição. Aguarde alguns minutos antes de tentar novamente.`,
    limite: max,
  };
}

export const forgotPasswordRequestLimiter = rateLimit({
  windowMs: quinzeMinutos,
  max: Number(process.env.FORGOT_PASSWORD_REQUEST_LIMIT || 3),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyByIp,
  message: message(Number(process.env.FORGOT_PASSWORD_REQUEST_LIMIT || 3)),
});

export const forgotPasswordConfirmLimiter = rateLimit({
  windowMs: quinzeMinutos,
  max: Number(process.env.FORGOT_PASSWORD_CONFIRM_LIMIT || 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyByIp,
  message: message(Number(process.env.FORGOT_PASSWORD_CONFIRM_LIMIT || 10)),
});

export const forgotPasswordResetLimiter = rateLimit({
  windowMs: quinzeMinutos,
  max: Number(process.env.FORGOT_PASSWORD_RESET_LIMIT || 5),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyByIp,
  message: message(Number(process.env.FORGOT_PASSWORD_RESET_LIMIT || 5)),
});

