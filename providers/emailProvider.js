import { EmailClient } from '@azure/communication-email';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';

const MODE = String(ENV.EMAIL_PROVIDER_MODE || 'stub').trim().toLowerCase();

export const isEmailProviderReal = MODE === 'ses' || MODE === 'acs';

let sesClient = null;
let acsClient = null;

function getSesClient() {
  if (!sesClient) {
    sesClient = new SESv2Client({ region: ENV.AWS_REGION || 'sa-east-1' });
  }

  return sesClient;
}

function getAcsClient() {
  if (!acsClient) {
    acsClient = new EmailClient(ENV.ACS_CONNECTION_STRING);
  }

  return acsClient;
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

function erroAcsParaResultado(error) {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  const codeStr = String(error?.code || error?.name || '').trim();
  const codeLower = codeStr.toLowerCase();
  const message = String(error?.message || error?.details || '').toLowerCase();

  if (
    statusCode >= 500 ||
    statusCode === 429 ||
    ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'TimeoutError'].includes(codeStr) ||
    codeStr === 'TooManyRequests' ||
    codeLower.includes('toomanyrequests') ||
    codeLower.includes('throttl') ||
    message.includes('too many requests') ||
    message.includes('throttl') ||
    message.includes('timeout')
  ) {
    return 'tempFalha';
  }

  if (
    codeLower.includes('invalidaddress') ||
    codeLower.includes('invalidemail') ||
    codeLower.includes('invalidrecipient') ||
    (
      (statusCode === 400 || statusCode === 0) &&
      (
        ((message.includes('invalid') || message.includes('malformed')) && (message.includes('address') || message.includes('email') || message.includes('recipient'))) ||
        codeLower.includes('invalid')
      )
    )
  ) {
    return 'invalido';
  }

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 404 ||
    statusCode === 400 ||
    ['BadRequest', 'Unauthorized', 'Forbidden', 'NotFound'].includes(codeStr)
  ) {
    return 'permFalha';
  }

  return 'tempFalha';
}

function prepararAssunto(assunto) {
  const normalized = String(assunto || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (normalized || 'Mensagem da FisioHelp').slice(0, 200);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function aguardarAcs(poller, { timeoutMs = 180_000, intervalMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (!poller.isDone()) {
    if (Date.now() > deadline) {
      return {
        status: 'TimedOut',
        error: { code: 'TimeoutError', message: 'Timeout ao aguardar aceite do ACS.' },
      };
    }

    await poller.poll();
    if (!poller.isDone()) {
      await delay(intervalMs);
    }
  }

  return poller.getResult();
}

function prepararAnexos(anexos) {
  if (anexos === null || anexos === undefined) return [];
  if (!Array.isArray(anexos)) {
    throw new Error('Anexos de e-mail devem ser uma lista.');
  }

  const normalizados = anexos.map((anexo, index) => {
    const name = String(anexo?.name || '').replace(/[\r\n]+/g, ' ').trim();
    const contentType = String(anexo?.contentType || '').trim().toLowerCase();
    const contentInBase64 = String(anexo?.contentInBase64 || '').trim();
    const contentIdRaw = String(anexo?.contentId || '').trim();

    if (!name || name.length > 255) {
      throw new Error(`Nome inválido no anexo de e-mail ${index + 1}.`);
    }
    if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(contentType)) {
      throw new Error(`Content-Type inválido no anexo de e-mail ${index + 1}.`);
    }
    if (!contentInBase64) {
      throw new Error(`Conteúdo ausente no anexo de e-mail ${index + 1}.`);
    }
    if (contentIdRaw && !/^[A-Za-z0-9._-]{1,120}$/.test(contentIdRaw)) {
      throw new Error(`Content-ID inválido no anexo de e-mail ${index + 1}.`);
    }

    return {
      name,
      contentType,
      contentInBase64,
      contentId: contentIdRaw || undefined,
    };
  });

  const totalBytesAproximado = normalizados.reduce(
    (total, anexo) => total + Math.ceil((anexo.contentInBase64.length * 3) / 4),
    0
  );
  if (totalBytesAproximado > 8 * 1024 * 1024) {
    throw new Error('Anexos de e-mail excedem o limite seguro de 8 MB.');
  }

  return normalizados;
}

// resultado: 'sucesso' | 'invalido' | 'tempFalha' | 'permFalha'
export async function enviarEmail({ destinatario, assunto, corpoHtml, corpoTexto, anexos = null }) {
  const email = String(destinatario || '').trim();
  const assuntoNormalizado = prepararAssunto(assunto);
  const anexosPreparados = prepararAnexos(anexos);

  if (!email) {
    return { resultado: 'invalido', erro: 'Destinatário de e-mail vazio.' };
  }

  if (!isEmailProviderReal) {
    log('info', '[email:stub] envio simulado', {
      destinatario: mascararEmail(email),
      assunto: assuntoNormalizado,
    });

    return { resultado: 'sucesso' };
  }

  if (MODE === 'acs') {
    if (!ENV.ACS_CONNECTION_STRING) {
      return { resultado: 'permFalha', erro: 'ACS_CONNECTION_STRING não configurado.' };
    }

    if (!ENV.ACS_SENDER_ADDRESS) {
      return { resultado: 'permFalha', erro: 'ACS_SENDER_ADDRESS não configurado.' };
    }

    try {
      const message = {
        senderAddress: ENV.ACS_SENDER_ADDRESS,
        content: {
          subject: assuntoNormalizado,
          html: String(corpoHtml || ''),
          plainText: String(corpoTexto || ''),
        },
        recipients: {
          to: [{ address: email }],
        },
        attachments: anexosPreparados.length > 0 ? anexosPreparados : undefined,
        replyTo: ENV.EMAIL_REPLY_TO ? [{ address: ENV.EMAIL_REPLY_TO }] : undefined,
      };

      const poller = await getAcsClient().beginSend(message);
      const result = await aguardarAcs(poller);

      if (result?.status === 'TimedOut') {
        log('warn', '[email:acs] timeout-aceite-indeterminado — e-mail pode ter sido aceito', {
          destinatario: mascararEmail(email),
        });
      }

      if (result?.status === 'Succeeded') {
        log('info', '[email:acs] e-mail aceito pelo ACS', {
          destinatario: mascararEmail(email),
          messageId: result?.id || null,
        });

        return { resultado: 'sucesso', messageId: result?.id || null };
      }

      return {
        resultado: erroAcsParaResultado(result?.error),
        erro: result?.error?.message || `Envio ACS finalizado com status ${result?.status || 'desconhecido'}.`,
      };
    } catch (error) {
      return {
        resultado: erroAcsParaResultado(error),
        erro: error?.message || 'Falha ao enviar e-mail via ACS.',
      };
    }
  }

  if (anexosPreparados.length > 0) {
    return {
      resultado: 'permFalha',
      erro: 'Anexos inline não são suportados pelo provider SES configurado.',
    };
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
