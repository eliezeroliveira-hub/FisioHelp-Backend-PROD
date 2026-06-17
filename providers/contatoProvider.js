// providers/contatoProvider.js
// Provider plugável para envio síncrono de códigos de verificação.
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';

const MODE = String(ENV.CONTATO_PROVIDER_MODE || 'stub').trim().toLowerCase();

export const isContatoProviderReal = MODE === 'ses';

let sesClient = null;

function getSesClient() {
  if (!sesClient) {
    sesClient = new SESv2Client({ region: ENV.AWS_REGION || 'sa-east-1' });
  }

  return sesClient;
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

function textoFallback(codigo) {
  return `Seu codigo de verificacao FisioHelp e: ${codigo}`;
}

function buildEmailBody({ html, texto }) {
  const textBody = String(texto || '').trim();
  const body = {
    Text: {
      Charset: 'UTF-8',
      Data: textBody,
    },
  };

  if (html && String(html).trim()) {
    body.Html = {
      Charset: 'UTF-8',
      Data: String(html),
    };
  }

  return body;
}

function sanitizeSubject(assunto, fallback) {
  return String(assunto || fallback).replace(/[\r\n]+/g, ' ').trim();
}

async function enviarEmail({ destino, assunto, html, texto }) {
  const canalNorm = 'Email';
  const destinoMascarado = mascararDestino(canalNorm, destino);
  const subject = sanitizeSubject(assunto, 'Mensagem FisioHelp');
  const textBody = String(texto || '').trim();

  if (MODE === 'stub') {
    log('info', '[contatoProvider:stub] E-mail transacional gerado', {
      canal: canalNorm,
      destinoMascarado,
      assunto: subject,
    });
    return { ok: true, modo: 'stub' };
  }

  if (MODE !== 'ses') {
    throw new Error(`CONTATO_PROVIDER_MODE inválido: ${MODE}`);
  }

  if (!destino || !String(destino).trim()) {
    throw new Error('Destino de e-mail não informado.');
  }
  if (!textBody && (!html || !String(html).trim())) {
    throw new Error('Conteúdo do e-mail não informado.');
  }

  try {
    await getSesClient().send(new SendEmailCommand({
      FromEmailAddress: ENV.EMAIL_FROM,
      Destination: {
        ToAddresses: [String(destino).trim()],
      },
      ReplyToAddresses: ENV.EMAIL_REPLY_TO ? [ENV.EMAIL_REPLY_TO] : undefined,
      Content: {
        Simple: {
          Subject: {
            Charset: 'UTF-8',
            Data: subject,
          },
          Body: buildEmailBody({ html, texto: textBody }),
        },
      },
    }));

    log('info', 'E-mail transacional enviado por SES', {
      canal: canalNorm,
      destinoMascarado,
      assunto: subject,
    });

    return { ok: true, modo: 'ses' };
  } catch (err) {
    log('error', 'Falha ao enviar e-mail transacional por SES', {
      canal: canalNorm,
      destinoMascarado,
      assunto: subject,
      erro: err?.message,
      name: err?.name,
      statusCode: err?.$metadata?.httpStatusCode,
    });
    throw err;
  }
}

async function enviarCodigo({ canal, destino, codigo, assunto, html, texto }) {
  const canalNorm = String(canal || '').trim();
  const destinoMascarado = mascararDestino(canalNorm, destino);
  const subject = sanitizeSubject(assunto, 'Código de verificação FisioHelp');
  const textBody = String(texto || textoFallback(codigo)).trim();
  const isProd = String(ENV.NODE_ENV || '').toLowerCase() === 'production';

  if (MODE === 'stub') {
    log('info', '[contatoProvider:stub] Código de verificação gerado', {
      canal: canalNorm,
      destinoMascarado,
      assunto: subject,
      ...(isProd ? {} : { codigo }),
    });
    return { ok: true, modo: 'stub', ...(isProd ? {} : { codigo }) };
  }

  if (MODE !== 'ses') {
    throw new Error(`CONTATO_PROVIDER_MODE inválido: ${MODE}`);
  }

  if (canalNorm !== 'Email') {
    throw new Error(`Canal ${canalNorm} não suportado pelo contatoProvider SES.`);
  }

  if (!destino || !String(destino).trim()) {
    throw new Error('Destino de e-mail não informado.');
  }

  try {
    await getSesClient().send(new SendEmailCommand({
      FromEmailAddress: ENV.EMAIL_FROM,
      Destination: {
        ToAddresses: [String(destino).trim()],
      },
      ReplyToAddresses: ENV.EMAIL_REPLY_TO ? [ENV.EMAIL_REPLY_TO] : undefined,
      Content: {
        Simple: {
          Subject: {
            Charset: 'UTF-8',
            Data: subject,
          },
          Body: buildEmailBody({ html, texto: textBody }),
        },
      },
    }));

    log('info', 'Código de verificação enviado por SES', {
      canal: canalNorm,
      destinoMascarado,
      assunto: subject,
    });

    return { ok: true, modo: 'ses' };
  } catch (err) {
    log('error', 'Falha ao enviar código de verificação por SES', {
      canal: canalNorm,
      destinoMascarado,
      assunto: subject,
      erro: err?.message,
      name: err?.name,
      statusCode: err?.$metadata?.httpStatusCode,
    });
    throw err;
  }
}

export default {
  enviarCodigo,
  enviarEmail,
  mascararDestino,
  isContatoProviderReal,
};
