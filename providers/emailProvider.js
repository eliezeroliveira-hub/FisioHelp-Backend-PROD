import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';

const MODE = String(ENV.EMAIL_PROVIDER_MODE || 'stub').trim().toLowerCase();

export const isEmailProviderReal = MODE === 'ses';

let sesClient = null;

function getSesClient() {
  if (!sesClient) {
    sesClient = new SESv2Client({ region: ENV.AWS_REGION || 'sa-east-1' });
  }

  return sesClient;
}

export function mascararEmail(email) {
  const value = String(email || '').trim();
  if (!value) return '(vazio)';

  const [local, domain] = value.split('@');
  if (!domain) return value.length <= 2 ? `${value.slice(0, 1)}*` : `${value.slice(0, 1)}****`;

  const first = local.slice(0, 1) || '*';
  return `${first}****@${domain}`;
}

function erroSesParaResultado(error) {
  const name = String(error?.name || error?.Code || error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  const statusCode = Number(error?.$metadata?.httpStatusCode || error?.statusCode || 0);

  if (
    statusCode >= 500 ||
    /throttl|too\s*many\s*requests|rate exceeded|limit exceeded/i.test(name) ||
    message.includes('throttl') ||
    message.includes('too many requests') ||
    message.includes('rate exceeded') ||
    ['TimeoutError', 'NetworkingError', 'RequestTimeout', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED'].includes(name)
  ) {
    return 'tempFalha';
  }

  if (
    message.includes('suppression') ||
    message.includes('suppressed') ||
    message.includes('not verified') ||
    message.includes('invalid email') ||
    message.includes('invalid address') ||
    message.includes('address format') ||
    message.includes('illegal address')
  ) {
    return 'invalido';
  }

  if (
    ['BadRequestException', 'MessageRejected', 'MailFromDomainNotVerifiedException', 'AccountSuspendedException', 'SendingPausedException', 'NotFoundException'].includes(name) ||
    statusCode === 400 ||
    statusCode === 403 ||
    statusCode === 404
  ) {
    return 'permFalha';
  }

  return 'tempFalha';
}

function prepararAssunto(assunto) {
  const normalized = String(assunto || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (normalized || 'Mensagem da FisioHelp').slice(0, 200);
}

// resultado: 'sucesso' | 'invalido' | 'tempFalha' | 'permFalha'
export async function enviarEmail({ destinatario, assunto, corpoHtml, corpoTexto }) {
  const email = String(destinatario || '').trim();
  const assuntoNormalizado = prepararAssunto(assunto);

  if (!email) {
    return { resultado: 'invalido', erro: 'Destinatário de e-mail vazio.' };
  }

  if (MODE !== 'ses') {
    log('info', '[email:stub] envio simulado', {
      destinatario: mascararEmail(email),
      assunto: assuntoNormalizado,
    });

    return { resultado: 'sucesso' };
  }

  if (!ENV.EMAIL_FROM) {
    return { resultado: 'permFalha', erro: 'EMAIL_FROM não configurado.' };
  }

  try {
    const command = new SendEmailCommand({
      FromEmailAddress: ENV.EMAIL_FROM,
      Destination: {
        ToAddresses: [email],
      },
      ReplyToAddresses: ENV.EMAIL_REPLY_TO ? [ENV.EMAIL_REPLY_TO] : undefined,
      Content: {
        Simple: {
          Subject: {
            Data: assuntoNormalizado,
            Charset: 'UTF-8',
          },
          Body: {
            Html: {
              Data: String(corpoHtml || ''),
              Charset: 'UTF-8',
            },
            Text: {
              Data: String(corpoTexto || ''),
              Charset: 'UTF-8',
            },
          },
        },
      },
    });

    const response = await getSesClient().send(command);

    log('info', '[email:ses] e-mail aceito pelo SES', {
      destinatario: mascararEmail(email),
      messageId: response?.MessageId || null,
    });

    return { resultado: 'sucesso', messageId: response?.MessageId || null };
  } catch (error) {
    return {
      resultado: erroSesParaResultado(error),
      erro: error?.message || 'Falha ao enviar e-mail via SES.',
    };
  }
}

export default {
  enviarEmail,
  isEmailProviderReal,
  mascararEmail,
};
