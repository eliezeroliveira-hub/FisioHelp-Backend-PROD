import rateLimit from 'express-rate-limit';
import { rateLimitKeyByIp } from '../utils/clientIp.js';

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const windowMs = parsePositiveInt(process.env.API_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
const max = parsePositiveInt(process.env.API_RATE_LIMIT_MAX, 200);
const pagamentosWebhookWindowMs = parsePositiveInt(process.env.PAGAMENTOS_WEBHOOK_RATE_LIMIT_WINDOW_MS, 60 * 1000);
const pagamentosWebhookMax = parsePositiveInt(process.env.PAGAMENTOS_WEBHOOK_RATE_LIMIT_MAX, 300);
const emailWebhookWindowMs = parsePositiveInt(process.env.EMAIL_WEBHOOK_RATE_LIMIT_WINDOW_MS, 60 * 1000);
const emailWebhookMax = parsePositiveInt(process.env.EMAIL_WEBHOOK_RATE_LIMIT_MAX, 300);
const twilioWhatsappWebhookWindowMs = parsePositiveInt(process.env.TWILIO_WHATSAPP_WEBHOOK_RATE_LIMIT_WINDOW_MS, 60 * 1000);
const twilioWhatsappWebhookMax = parsePositiveInt(process.env.TWILIO_WHATSAPP_WEBHOOK_RATE_LIMIT_MAX, 300);
const contatoPublicoWindowMs = parsePositiveInt(process.env.CONTATO_PUBLICO_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
const contatoPublicoMax = parsePositiveInt(process.env.CONTATO_PUBLICO_RATE_LIMIT_MAX, 5);
const contatoPublicoEmailWindowMs = parsePositiveInt(process.env.CONTATO_PUBLICO_EMAIL_RATE_LIMIT_WINDOW_MS, 30 * 60 * 1000);
const contatoPublicoEmailMax = parsePositiveInt(process.env.CONTATO_PUBLICO_EMAIL_RATE_LIMIT_MAX, 3);
const fisioCadastroContatoIpWindowMs = parsePositiveInt(
  process.env.FISIO_CADASTRO_CONTATO_IP_RATE_LIMIT_WINDOW_MS,
  15 * 60 * 1000
);
const fisioCadastroContatoIpMax = parsePositiveInt(process.env.FISIO_CADASTRO_CONTATO_IP_RATE_LIMIT_MAX, 20);
const fisioCadastroEmailWindowMs = parsePositiveInt(
  process.env.FISIO_CADASTRO_EMAIL_RATE_LIMIT_WINDOW_MS,
  30 * 60 * 1000
);
const fisioCadastroEmailMax = parsePositiveInt(process.env.FISIO_CADASTRO_EMAIL_RATE_LIMIT_MAX, 5);
const fisioCadastroTelefoneWindowMs = parsePositiveInt(
  process.env.FISIO_CADASTRO_TELEFONE_RATE_LIMIT_WINDOW_MS,
  60 * 60 * 1000
);
const fisioCadastroTelefoneMax = parsePositiveInt(process.env.FISIO_CADASTRO_TELEFONE_RATE_LIMIT_MAX, 4);
const pacienteCadastroContatoIpWindowMs = parsePositiveInt(
  process.env.PACIENTE_CADASTRO_CONTATO_IP_RATE_LIMIT_WINDOW_MS,
  15 * 60 * 1000
);
const pacienteCadastroContatoIpMax = parsePositiveInt(process.env.PACIENTE_CADASTRO_CONTATO_IP_RATE_LIMIT_MAX, 20);
const pacienteCadastroEmailWindowMs = parsePositiveInt(
  process.env.PACIENTE_CADASTRO_EMAIL_RATE_LIMIT_WINDOW_MS,
  30 * 60 * 1000
);
const pacienteCadastroEmailMax = parsePositiveInt(process.env.PACIENTE_CADASTRO_EMAIL_RATE_LIMIT_MAX, 5);
const pacienteCadastroTelefoneWindowMs = parsePositiveInt(
  process.env.PACIENTE_CADASTRO_TELEFONE_RATE_LIMIT_WINDOW_MS,
  60 * 60 * 1000
);
const pacienteCadastroTelefoneMax = parsePositiveInt(process.env.PACIENTE_CADASTRO_TELEFONE_RATE_LIMIT_MAX, 4);

function normalizarEmailRateLimit(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizarTelefoneRateLimit(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits.slice(2);
  return digits;
}

export const apiLimiter = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyByIp,
  message: { erro: 'Muitas requisições. Tente novamente em alguns minutos.' },
  // Webhook pode receber bursts do provedor e não deve competir com limite global.
  skip: (req) =>
    req.method === 'POST' &&
    (
      String(req.originalUrl || '').startsWith('/api/pagamentos/webhook/standby') ||
      String(req.originalUrl || '').startsWith('/api/pagamentos/webhook/asaas') ||
      String(req.originalUrl || '').startsWith('/api/notificacoes/webhook/')
    )
});

export const pagamentosWebhookLimiter = rateLimit({
  windowMs: pagamentosWebhookWindowMs,
  max: pagamentosWebhookMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyByIp,
  message: { erro: 'Muitas notificações recebidas. Tente novamente em instantes.' }
});

export const emailWebhookLimiter = rateLimit({
  windowMs: emailWebhookWindowMs,
  max: emailWebhookMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyByIp,
  message: { erro: 'Muitos eventos de e-mail recebidos. Tente novamente em instantes.' }
});

export const twilioWhatsappWebhookLimiter = rateLimit({
  windowMs: twilioWhatsappWebhookWindowMs,
  max: twilioWhatsappWebhookMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyByIp,
  message: { erro: 'Muitos eventos de WhatsApp recebidos. Tente novamente em instantes.' }
});

export const contatoPublicoIpLimiter = rateLimit({
  windowMs: contatoPublicoWindowMs,
  max: contatoPublicoMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyByIp,
  message: { erro: 'Muitas mensagens enviadas. Tente novamente em alguns minutos.' }
});

export const contatoPublicoEmailLimiter = rateLimit({
  windowMs: contatoPublicoEmailWindowMs,
  max: contatoPublicoEmailMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `email:${normalizarEmailRateLimit(req.body?.email) || 'nao-informado'}`,
  message: { erro: 'Muitas mensagens enviadas para este e-mail. Tente novamente mais tarde.' }
});

export const cadastroFisioContatoIpLimiter = rateLimit({
  windowMs: fisioCadastroContatoIpWindowMs,
  max: fisioCadastroContatoIpMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyByIp,
  message: { erro: 'Muitas tentativas de validação. Tente novamente em alguns minutos.' }
});

export const cadastroFisioEmailLimiter = rateLimit({
  windowMs: fisioCadastroEmailWindowMs,
  max: fisioCadastroEmailMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `fisio-email:${normalizarEmailRateLimit(req.body?.Email ?? req.body?.email) || 'nao-informado'}`,
  message: { erro: 'Muitas solicitações para este e-mail. Tente novamente mais tarde.' }
});

export const cadastroFisioTelefoneLimiter = rateLimit({
  windowMs: fisioCadastroTelefoneWindowMs,
  max: fisioCadastroTelefoneMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const telefone = normalizarTelefoneRateLimit(req.body?.Telefone ?? req.body?.telefone);
    const sessao = String(req.body?.CadastroValidacaoId ?? req.body?.cadastroValidacaoId ?? '').trim().toLowerCase();
    return `fisio-telefone:${telefone || sessao || 'nao-informado'}`;
  },
  message: { erro: 'Muitas solicitações para este telefone. Tente novamente mais tarde.' }
});

export const cadastroPacienteContatoIpLimiter = rateLimit({
  windowMs: pacienteCadastroContatoIpWindowMs,
  max: pacienteCadastroContatoIpMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyByIp,
  message: { erro: 'Muitas tentativas de validação. Tente novamente em alguns minutos.' }
});

export const cadastroPacienteEmailLimiter = rateLimit({
  windowMs: pacienteCadastroEmailWindowMs,
  max: pacienteCadastroEmailMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `paciente-email:${normalizarEmailRateLimit(req.body?.Email ?? req.body?.email) || 'nao-informado'}`,
  message: { erro: 'Muitas solicitações para este e-mail. Tente novamente mais tarde.' }
});

export const cadastroPacienteTelefoneLimiter = rateLimit({
  windowMs: pacienteCadastroTelefoneWindowMs,
  max: pacienteCadastroTelefoneMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const telefone = normalizarTelefoneRateLimit(req.body?.Telefone ?? req.body?.telefone);
    const sessao = String(req.body?.CadastroValidacaoId ?? req.body?.cadastroValidacaoId ?? '').trim().toLowerCase();
    return `paciente-telefone:${telefone || sessao || 'nao-informado'}`;
  },
  message: { erro: 'Muitas solicitações para este telefone. Tente novamente mais tarde.' }
});

export default apiLimiter;

