import crypto from 'crypto';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import emailSupressaoService from '../services/emailSupressaoService.js';

const SNS_CERT_CACHE = new Map();

function secretsMatch(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;

  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

function parseBody(body) {
  if (typeof body === 'string') {
    const text = body.trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  if (body && typeof body === 'object') return body;
  return null;
}

function detalheEvento(evento) {
  return {
    recebidoEm: new Date().toISOString(),
    evento,
  };
}

function motivoAcs(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'bounced') return 'Bounce';
  if (value === 'suppressed') return 'Suppressed';
  return null;
}

function isTrustedSnsUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (url.protocol !== 'https:') return false;
    if (!/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/i.test(url.hostname)) return false;
    return url.pathname.endsWith('.pem') || url.searchParams.get('Action') === 'ConfirmSubscription';
  } catch {
    return false;
  }
}

function canonicalSnsPayload(message) {
  const type = String(message?.Type || '');

  if (type === 'Notification') {
    const fields = ['Message', 'MessageId'];
    if (message.Subject !== undefined) fields.push('Subject');
    fields.push('Timestamp', 'TopicArn', 'Type');
    return fields.map((field) => `${field}\n${message[field] ?? ''}\n`).join('');
  }

  if (type === 'SubscriptionConfirmation' || type === 'UnsubscribeConfirmation') {
    const fields = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
    return fields.map((field) => `${field}\n${message[field] ?? ''}\n`).join('');
  }

  return null;
}

async function obterCertificadoSns(url) {
  if (SNS_CERT_CACHE.has(url)) return SNS_CERT_CACHE.get(url);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Falha ao obter certificado SNS (${response.status}).`);
  }

  const cert = await response.text();
  SNS_CERT_CACHE.set(url, cert);
  return cert;
}

async function validarAssinaturaSns(message) {
  if (!message?.Signature || !message?.SigningCertURL || !message?.SignatureVersion) {
    return false;
  }
  if (!isTrustedSnsUrl(message.SigningCertURL)) {
    return false;
  }

  const canonical = canonicalSnsPayload(message);
  if (!canonical) return false;

  const cert = await obterCertificadoSns(message.SigningCertURL);
  const algorithm = String(message.SignatureVersion) === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
  const verifier = crypto.createVerify(algorithm);
  verifier.update(canonical, 'utf8');
  return verifier.verify(cert, message.Signature, 'base64');
}

function validarTopicArn(message) {
  const expected = ENV.SES_SNS_TOPIC_ARN;
  if (!expected) {
    const err = new Error('SES_SNS_TOPIC_ARN não configurado.');
    err.statusCode = 500;
    throw err;
  }
  if (String(message?.TopicArn || '') !== String(expected)) {
    const err = new Error('TopicArn SNS inesperado.');
    err.statusCode = 403;
    throw err;
  }
}

function emailsSesBounce(message) {
  const payload = parseBody(message?.Message);
  const notificationType = String(payload?.notificationType || payload?.eventType || '');
  const bounceType = String(payload?.bounce?.bounceType || '');

  if (notificationType !== 'Bounce') {
    return { motivo: null, emails: [], payload };
  }

  const emails = Array.isArray(payload?.bounce?.bouncedRecipients)
    ? payload.bounce.bouncedRecipients.map((item) => item?.emailAddress).filter(Boolean)
    : [];

  return {
    motivo: bounceType === 'Permanent' ? 'Bounce' : null,
    emails,
    payload,
  };
}

function emailsSesComplaint(message) {
  const payload = parseBody(message?.Message);
  const notificationType = String(payload?.notificationType || payload?.eventType || '');

  if (notificationType !== 'Complaint') {
    return { motivo: null, emails: [], payload };
  }

  const emails = Array.isArray(payload?.complaint?.complainedRecipients)
    ? payload.complaint.complainedRecipients.map((item) => item?.emailAddress).filter(Boolean)
    : [];

  return {
    motivo: 'Complaint',
    emails,
    payload,
  };
}

const notificacoesWebhookController = {
  async eventGrid(req, res) {
    const expected = ENV.ACS_EVENTGRID_WEBHOOK_SECRET;
    const received = String(req.query?.code || '');

    if (!expected) {
      return res.status(500).json({ erro: 'ACS_EVENTGRID_WEBHOOK_SECRET não configurado.' });
    }
    if (!secretsMatch(received, expected)) {
      return res.status(401).json({ erro: 'Webhook não autorizado.' });
    }

    const body = parseBody(req.body);
    const eventos = asArray(body);

    const validation = eventos.find((event) => event?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent');
    if (validation) {
      return res.status(200).json({
        validationResponse: validation?.data?.validationCode,
      });
    }

    try {
      for (const event of eventos) {
        if (event?.eventType !== 'Microsoft.Communication.EmailDeliveryReportReceived') {
          continue;
        }

        const data = event.data || {};
        const recipient = data.recipient;
        const status = data.status ?? data.deliveryStatus;
        const motivo = motivoAcs(status);

        if (!motivo) {
          if (['Failed', 'FilteredSpam', 'Quarantined'].includes(String(status || ''))) {
            log('info', 'Evento ACS de e-mail sem supressão', {
              status,
              messageId: data.messageId ?? null,
            });
          }
          continue;
        }

        await emailSupressaoService.suprimirEmail({
          email: recipient,
          motivo,
          provider: 'acs',
          detalhe: detalheEvento(event),
        });

        log('info', 'E-mail suprimido por evento ACS', {
          motivo,
          status,
          messageId: data.messageId ?? null,
        });
      }

      return res.status(200).json({ received: true });
    } catch (err) {
      log('error', 'Erro ao processar webhook ACS Event Grid', { erro: err?.message });
      return res.status(200).json({ received: true });
    }
  },

  async sesSns(req, res) {
    const message = parseBody(req.body);
    if (!message) {
      return res.status(400).json({ erro: 'Payload SNS inválido.' });
    }

    try {
      const assinaturaValida = await validarAssinaturaSns(message);
      if (!assinaturaValida) {
        return res.status(403).json({ erro: 'Assinatura SNS inválida.' });
      }

      validarTopicArn(message);

      if (message.Type === 'SubscriptionConfirmation') {
        if (!isTrustedSnsUrl(message.SubscribeURL)) {
          return res.status(403).json({ erro: 'SubscribeURL SNS inválida.' });
        }

        const response = await fetch(message.SubscribeURL);
        log(response.ok ? 'info' : 'warn', 'Confirmação de subscription SNS processada', {
          ok: response.ok,
          status: response.status,
        });
        return res.status(200).json({ received: true, confirmed: response.ok });
      }

      if (message.Type !== 'Notification') {
        return res.status(200).json({ received: true });
      }

      const bounce = emailsSesBounce(message);
      const complaint = emailsSesComplaint(message);
      const evento = bounce.motivo ? bounce : complaint;

      if (!evento.motivo) {
        log('info', 'Evento SES/SNS sem supressão', {
          type: message.Type,
          notificationType: parseBody(message.Message)?.notificationType ?? null,
        });
        return res.status(200).json({ received: true });
      }

      for (const email of evento.emails) {
        await emailSupressaoService.suprimirEmail({
          email,
          motivo: evento.motivo,
          provider: 'ses',
          detalhe: detalheEvento({
            sns: message,
            ses: evento.payload,
          }),
        });
      }

      log('info', 'Evento SES/SNS processado para supressão', {
        motivo: evento.motivo,
        total: evento.emails.length,
      });

      return res.status(200).json({ received: true });
    } catch (err) {
      const status = err?.statusCode || 500;
      log(status >= 500 ? 'error' : 'warn', 'Erro ao processar webhook SES/SNS', {
        erro: err?.message,
      });
      return res.status(status >= 500 ? 200 : status).json({ received: status >= 500, erro: status >= 500 ? undefined : err?.message });
    }
  },
};

export default notificacoesWebhookController;
