import rateLimit from 'express-rate-limit';

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const windowMs = parsePositiveInt(process.env.REFRESH_RATE_LIMIT_WINDOW_MS, 60 * 1000);
const max = parsePositiveInt(process.env.REFRESH_RATE_LIMIT_MAX, 20);

export const refreshLimiter = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de renovação de token. Tente novamente em instantes.' }
});

export default refreshLimiter;
