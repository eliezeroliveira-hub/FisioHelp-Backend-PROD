import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';

const MODE = String(ENV.PUSH_PROVIDER_MODE || 'stub').trim().toLowerCase();
const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';

export const isProviderReal = MODE === 'expo' || MODE === 'fcm' || MODE === 'apns';

export function maskToken(token) {
  const value = String(token || '').trim();
  if (!value) return '(vazio)';
  if (value.length <= 12) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function isExpoPushToken(token) {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(String(token || '').trim());
}

function erroExpoParaResultado(errorCode) {
  switch (String(errorCode || '').trim()) {
    case 'DeviceNotRegistered':
      return 'invalido';
    case 'MessageRateExceeded':
    case 'TOO_MANY_REQUESTS':
      return 'tempFalha';
    case 'MessageTooBig':
    case 'InvalidCredentials':
    case 'MismatchSenderId':
      return 'permFalha';
    default:
      return 'permFalha';
  }
}

function montarPayloadExpo({ tokenPush, titulo, mensagem, dados }) {
  return {
    to: tokenPush,
    title: titulo || 'FisioHelp',
    body: String(mensagem || ''),
    data: dados && typeof dados === 'object' ? dados : {},
    sound: 'default',
    priority: 'default',
    channelId: 'default',
  };
}

async function enviarExpoPush(params) {
  const tokenPush = String(params?.tokenPush || '').trim();
  if (!isExpoPushToken(tokenPush)) {
    return {
      resultado: 'invalido',
      erro: 'Token Expo Push inválido.',
    };
  }

  const headers = {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Content-Type': 'application/json',
  };

  if (ENV.EXPO_PUSH_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${ENV.EXPO_PUSH_ACCESS_TOKEN}`;
  }

  const response = await fetch(EXPO_PUSH_SEND_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(montarPayloadExpo({ ...params, tokenPush })),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const errorCode = body?.errors?.[0]?.code || body?.errors?.[0]?.details?.error;
    const message = body?.errors?.[0]?.message || `Expo Push Service retornou HTTP ${response.status}.`;

    if (response.status === 429 || response.status >= 500) {
      return { resultado: 'tempFalha', erro: message };
    }

    return {
      resultado: erroExpoParaResultado(errorCode),
      erro: message,
    };
  }

  const ticket = Array.isArray(body?.data) ? body.data[0] : body?.data;
  if (!ticket) {
    return {
      resultado: 'tempFalha',
      erro: 'Resposta do Expo Push Service sem ticket.',
    };
  }

  if (ticket.status === 'ok') {
    log('info', '[push:expo] notificação aceita pelo Expo Push Service', {
      token: maskToken(tokenPush),
      ticketId: ticket.id || null,
    });

    return {
      resultado: 'sucesso',
      ticketId: ticket.id || null,
    };
  }

  const errorCode = ticket?.details?.error;
  return {
    resultado: erroExpoParaResultado(errorCode),
    erro: ticket.message || errorCode || 'Expo Push Service recusou a notificação.',
    ticketId: ticket.id || null,
  };
}

// resultado: 'sucesso' | 'invalido' | 'tempFalha' | 'permFalha'
export async function enviarPush({ tokenPush, plataforma, titulo, mensagem, dados }) {
  if (MODE === 'expo') {
    return enviarExpoPush({ tokenPush, plataforma, titulo, mensagem, dados });
  }

  if (MODE === 'fcm' || MODE === 'apns') {
    throw new Error(`Provider '${MODE}' ainda não implementado.`);
  }

  log('info', '[push:stub] envio simulado', {
    plataforma,
    token: maskToken(tokenPush),
    titulo: titulo || null,
    mensagem: mensagem ? String(mensagem).slice(0, 80) : null,
    possuiDados: dados !== null && dados !== undefined
  });

  return { resultado: 'sucesso' };
}

export default {
  enviarPush,
  isProviderReal,
  maskToken,
};
