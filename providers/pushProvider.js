import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';

const MODE = String(ENV.PUSH_PROVIDER_MODE || 'stub').trim().toLowerCase();

export const isProviderReal = MODE === 'fcm' || MODE === 'apns';

export function maskToken(token) {
  const value = String(token || '').trim();
  if (!value) return '(vazio)';
  if (value.length <= 12) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

// resultado: 'sucesso' | 'invalido' | 'tempFalha' | 'permFalha'
export async function enviarPush({ tokenPush, plataforma, titulo, mensagem, dados }) {
  if (isProviderReal) {
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
