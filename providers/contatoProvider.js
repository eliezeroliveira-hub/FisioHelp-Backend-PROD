// providers/contatoProvider.js
// Provider "plugável" para envio de códigos de verificação (Email/Telefone).
// Em DEV (NODE_ENV !== 'production'), apenas retorna o código no retorno para facilitar testes no Postman.
// Em PROD, implemente aqui a integração (SendGrid, SES, Twilio, Zenvia, WhatsApp etc).
import { log } from '../config/logger.js';

function isProd() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function mascararDestino(canal, destino) {
  const d = String(destino || '');
  if (!d) return d;

  if (String(canal).toLowerCase() === 'email') {
    const [user, domain] = d.split('@');
    if (!domain) return d;
    const u = user || '';
    const uMasked = u.length <= 2 ? `${u[0] || '*'}*` : `${u.slice(0, 2)}***${u.slice(-1)}`;
    return `${uMasked}@${domain}`;
  }

  // Telefone (E.164 ou somente dígitos)
  const digits = d.replace(/\D/g, '');
  if (digits.length <= 4) return `****${digits}`;
  return `****${digits.slice(-4)}`;
}

async function enviarCodigo({ canal, destino, codigo }) {
  // TODO: implementar integração real quando houver provedor.
  // Ex.: Email: SendGrid/SES. Telefone: Twilio/Zenvia/WhatsApp Cloud API.
  if (!isProd()) {
    console.log(`[DEV] Código de verificação (${canal}) para ${destino}: ${codigo}`);
    return { ok: true, modo: 'dev', codigo };
  }

  // Em produção, por padrão falha explicitamente para você não achar que está enviando.
  const erro = 'Provider de contato não configurado (produção).';
  log('error', 'Falha ao enviar código de verificação', {
    canal,
    destinoMascarado: mascararDestino(canal, destino),
    erro
  });
  throw new Error(erro);
}

export default {
  enviarCodigo,
  mascararDestino,
};
