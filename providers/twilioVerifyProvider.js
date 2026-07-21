import twilio from 'twilio';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';

const SERVICE_SID_PATTERN = /^VA[0-9a-f]{32}$/i;
const CODE_PATTERN = /^\d{6}$/;

let twilioClient = null;

export const isTwilioVerifyConfigured = Boolean(
  String(ENV.TWILIO_VERIFY_SERVICE_SID || '').trim()
);

function getTwilioClient() {
  if (!twilioClient) {
    twilioClient = twilio(ENV.TWILIO_ACCOUNT_SID, ENV.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

function normalizarTelefoneE164(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';

  const normalized = `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : '';
}

function mascararTelefone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '(vazio)';
  return digits.length <= 4 ? `****${digits}` : `+${digits.slice(0, 2)}****${digits.slice(-4)}`;
}

function erroConfiguracao(message) {
  const error = new Error(message);
  error.resultado = 'permFalha';
  return error;
}

function erroTwilio(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = Number(error?.code || 0);
  const permanent = status === 400 || status === 401 || status === 403 || code === 20003;
  const wrapped = new Error(error?.message || 'Falha ao enviar código por Twilio Verify.');
  wrapped.name = error?.name || 'TwilioVerifyError';
  wrapped.code = error?.code;
  wrapped.status = status || undefined;
  wrapped.resultado = permanent ? 'permFalha' : 'tempFalha';
  return wrapped;
}

export async function enviarCodigoSms({ destinatario, codigo }) {
  const serviceSid = String(ENV.TWILIO_VERIFY_SERVICE_SID || '').trim();
  const to = normalizarTelefoneE164(destinatario);
  const customCode = String(codigo || '').trim();

  if (!SERVICE_SID_PATTERN.test(serviceSid)) {
    throw erroConfiguracao('TWILIO_VERIFY_SERVICE_SID não configurado ou inválido.');
  }
  if (!ENV.TWILIO_ACCOUNT_SID) {
    throw erroConfiguracao('TWILIO_ACCOUNT_SID não configurado.');
  }
  if (!ENV.TWILIO_AUTH_TOKEN) {
    throw erroConfiguracao('TWILIO_AUTH_TOKEN não configurado.');
  }
  if (!to) {
    throw erroConfiguracao('Destino de telefone inválido para Twilio Verify.');
  }
  if (!CODE_PATTERN.test(customCode)) {
    throw erroConfiguracao('Código customizado inválido para Twilio Verify.');
  }

  try {
    const verification = await getTwilioClient().verify.v2
      .services(serviceSid)
      .verifications.create({
        to,
        channel: 'sms',
        customCode,
        riskCheck: 'enable',
      });

    log('info', '[verify:twilio] código SMS aceito pela Twilio', {
      destinatario: mascararTelefone(to),
      verificationSid: verification?.sid || null,
      status: verification?.status || null,
    });

    return {
      resultado: 'sucesso',
      verificationSid: verification?.sid || null,
      status: verification?.status || null,
    };
  } catch (error) {
    log('error', '[verify:twilio] falha ao enviar código SMS', {
      destinatario: mascararTelefone(to),
      erro: error?.message,
      code: error?.code,
      status: error?.status || error?.statusCode,
    });
    throw erroTwilio(error);
  }
}

export default {
  enviarCodigoSms,
  isTwilioVerifyConfigured,
};
