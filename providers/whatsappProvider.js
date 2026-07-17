import twilio from 'twilio';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';

const MODE = String(ENV.WHATSAPP_PROVIDER_MODE || 'stub').trim().toLowerCase();

export const isWhatsAppProviderReal = MODE === 'twilio';

let twilioClient = null;

function getTwilioClient() {
  if (!twilioClient) {
    twilioClient = twilio(ENV.TWILIO_ACCOUNT_SID, ENV.TWILIO_AUTH_TOKEN);
  }

  return twilioClient;
}

function normalizarWhatsAppAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^whatsapp:\+/i.test(raw)) {
    const digits = raw.replace(/^whatsapp:\+/i, '').replace(/\D/g, '');
    return digits ? `whatsapp:+${digits}` : '';
  }

  const digits = raw.replace(/\D/g, '');
  return digits ? `whatsapp:+${digits}` : '';
}

export function mascararWhatsApp(destinatario) {
  const normalized = normalizarWhatsAppAddress(destinatario);
  const digits = normalized.replace(/\D/g, '');

  if (!digits) return '(vazio)';
  if (digits.length <= 4) return `whatsapp:****${digits}`;

  return `whatsapp:+${digits.slice(0, 2)}****${digits.slice(-4)}`;
}

function prepararMensagem(mensagem) {
  return String(mensagem || '').replace(/\r\n/g, '\n').trim();
}

function prepararContentSid(value) {
  const sid = String(value || '').trim();
  if (!sid) return null;
  return /^HX[a-f0-9]{32}$/i.test(sid) ? sid : null;
}

function prepararContentVariables(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const variables = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => /^\d+$/.test(String(key)))
      .map(([key, variableValue]) => [String(key), String(variableValue ?? '')])
  );

  return Object.keys(variables).length > 0 ? JSON.stringify(variables) : null;
}

function isNetworkError(error) {
  const code = String(error?.code || error?.name || '').trim();
  return [
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'TimeoutError',
  ].includes(code);
}

function erroTwilioParaResultado(error) {
  const code = Number(error?.code || 0);
  const status = Number(error?.status || error?.statusCode || 0);
  const message = String(error?.message || '').toLowerCase();

  if (
    status >= 500 ||
    code === 20429 ||
    message.includes('too many requests') ||
    message.includes('rate limit') ||
    message.includes('timeout') ||
    isNetworkError(error)
  ) {
    return 'tempFalha';
  }

  if (
    [21211, 21608, 21610, 21614, 63003].includes(code) ||
    message.includes('invalid') ||
    message.includes('unverified') ||
    message.includes('not a valid') ||
    message.includes('not joined') ||
    message.includes('sandbox') ||
    message.includes('opt out') ||
    message.includes('unsubscribed')
  ) {
    return 'invalido';
  }

  if (
    [20003, 20404, 21212, 21606, 21612, 21659, 63007, 63016, 63018, 63028].includes(code) ||
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    message.includes('authentication') ||
    message.includes('permission') ||
    message.includes('not authorized') ||
    message.includes('not enabled')
  ) {
    return 'permFalha';
  }

  return 'tempFalha';
}

function erroConfig(message) {
  return { resultado: 'permFalha', erro: message };
}

// resultado: 'sucesso' | 'invalido' | 'tempFalha' | 'permFalha'
export async function enviarWhatsApp({
  destinatario,
  mensagem,
  statusCallbackUrl,
  contentSid,
  contentVariables,
  templateObrigatorio = false,
} = {}) {
  const to = normalizarWhatsAppAddress(destinatario);
  const body = prepararMensagem(mensagem);
  const from = normalizarWhatsAppAddress(ENV.TWILIO_WHATSAPP_FROM);
  const callbackUrl = String(statusCallbackUrl || ENV.TWILIO_WHATSAPP_STATUS_CALLBACK_URL || '').trim();
  const contentSidInformado = String(contentSid || '').trim();
  const templateSid = prepararContentSid(contentSidInformado);
  const templateVariables = prepararContentVariables(contentVariables);

  if (!to) {
    return { resultado: 'invalido', erro: 'Destinatário de WhatsApp vazio ou inválido.' };
  }

  if (contentSidInformado && !templateSid) {
    return erroConfig('Content SID do WhatsApp inválido. Use um SID iniciado por HX.');
  }

  if (isWhatsAppProviderReal && templateObrigatorio && !templateSid) {
    return erroConfig('Template WhatsApp obrigatório não configurado.');
  }

  if (!body && !templateSid) {
    return { resultado: 'permFalha', erro: 'Mensagem de WhatsApp vazia.' };
  }

  if (!isWhatsAppProviderReal) {
    log('info', '[whatsapp:stub] envio simulado', {
      destinatario: mascararWhatsApp(to),
      tamanhoMensagem: body.length,
      template: Boolean(templateSid),
      contentSid: templateSid,
    });

    return { resultado: 'sucesso' };
  }

  if (!ENV.TWILIO_ACCOUNT_SID) {
    return erroConfig('TWILIO_ACCOUNT_SID não configurado.');
  }

  if (!ENV.TWILIO_AUTH_TOKEN) {
    return erroConfig('TWILIO_AUTH_TOKEN não configurado.');
  }

  if (!from) {
    return erroConfig('TWILIO_WHATSAPP_FROM não configurado ou inválido.');
  }

  try {
    const payload = {
      from,
      to,
      ...(templateSid
        ? {
            contentSid: templateSid,
            ...(templateVariables ? { contentVariables: templateVariables } : {}),
          }
        : { body }),
      ...(callbackUrl ? { statusCallback: callbackUrl } : {}),
    };

    const response = await getTwilioClient().messages.create(payload);

    log('info', '[whatsapp:twilio] mensagem aceita pela Twilio', {
      destinatario: mascararWhatsApp(to),
      messageId: response?.sid || null,
      status: response?.status || null,
      template: Boolean(templateSid),
      contentSid: templateSid,
    });

    return {
      resultado: 'sucesso',
      messageId: response?.sid || null,
    };
  } catch (error) {
    return {
      resultado: erroTwilioParaResultado(error),
      erro: error?.message || 'Falha ao enviar WhatsApp via Twilio.',
    };
  }
}

export default {
  enviarWhatsApp,
  isWhatsAppProviderReal,
  mascararWhatsApp,
};
