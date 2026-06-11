import rateLimit from 'express-rate-limit';

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const windowMs = parsePositiveInt(process.env.API_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
const max = parsePositiveInt(process.env.API_RATE_LIMIT_MAX, 200);
const pagamentosWebhookWindowMs = parsePositiveInt(process.env.PAGAMENTOS_WEBHOOK_RATE_LIMIT_WINDOW_MS, 60 * 1000);
const pagamentosWebhookMax = parsePositiveInt(process.env.PAGAMENTOS_WEBHOOK_RATE_LIMIT_MAX, 300);

export const apiLimiter = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' },
  // Webhook pode receber bursts do provedor e não deve competir com limite global.
  skip: (req) =>
    req.method === 'POST' &&
    (
      String(req.originalUrl || '').startsWith('/api/pagamentos/webhook/standby') ||
      String(req.originalUrl || '').startsWith('/api/pagamentos/webhook/asaas')
    )
});

export const pagamentosWebhookLimiter = rateLimit({
  windowMs: pagamentosWebhookWindowMs,
  max: pagamentosWebhookMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas notificações recebidas. Tente novamente em instantes.' }
});

export default apiLimiter;
