import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import contatoProvider from '../providers/contatoProvider.js';
import { HttpError } from '../utils/httpError.js';
import { isValidEmail, normalizeEmail } from '../utils/identityValidators.js';
import {
  montarEmailContatoPublicoConfirmacao,
  montarEmailContatoPublicoInterno,
} from './contatoPublicoTemplates.js';

const SUCCESS_MESSAGE = 'Mensagem enviada com sucesso.';

function texto(value) {
  return String(value ?? '').trim();
}

function normalizarTelefone(value) {
  return texto(value).replace(/[^\d+()\-\s.]/g, '').replace(/\s+/g, ' ').slice(0, 30);
}

function validarTexto({ campo, valor, min = 0, max, obrigatorio = true }) {
  const value = texto(valor);

  if (obrigatorio && !value) {
    throw new HttpError(400, `${campo} é obrigatório.`);
  }

  if (value && value.length < min) {
    throw new HttpError(400, `${campo} deve ter pelo menos ${min} caracteres.`);
  }

  if (max && value.length > max) {
    throw new HttpError(400, `${campo} deve ter no máximo ${max} caracteres.`);
  }

  return value;
}

function erroEnvioInterno(err, payload) {
  log('error', 'Falha ao enviar contato público para o suporte', {
    nome: payload.nome,
    email: payload.email,
    telefone: payload.telefone || null,
    assunto: payload.assunto,
    mensagem: payload.mensagem,
    ip: payload.ip || null,
    userAgent: payload.userAgent || null,
    erro: err?.message,
    name: err?.name,
    code: err?.code,
    statusCode: err?.statusCode,
  });
}

export async function enviarContatoPublico({ body = {}, ip = null, userAgent = null } = {}) {
  const honeypot = texto(body?.empresa || body?.website || body?.url);
  if (honeypot) {
    log('info', 'Contato público ignorado por honeypot preenchido', {
      ip,
      userAgent,
    });
    return { sucesso: true, mensagem: SUCCESS_MESSAGE };
  }

  const nome = validarTexto({ campo: 'Nome', valor: body?.nome, min: 2, max: 120 });
  const email = normalizeEmail(body?.email);
  if (!email || email.length > 255 || !isValidEmail(email)) {
    throw new HttpError(400, 'E-mail inválido.');
  }

  const telefone = normalizarTelefone(body?.telefone);
  const assunto = validarTexto({ campo: 'Assunto', valor: body?.assunto, min: 3, max: 120 });
  const mensagem = validarTexto({ campo: 'Mensagem', valor: body?.mensagem, min: 10, max: 3000 });
  const destinoSuporte = texto(ENV.CONTATO_PUBLICO_DESTINO);

  if (!destinoSuporte) {
    throw new HttpError(500, 'Destino do formulário de contato não configurado.');
  }

  const payloadLog = {
    nome,
    email,
    telefone,
    assunto,
    mensagem,
    ip,
    userAgent,
  };

  const interno = montarEmailContatoPublicoInterno(payloadLog);

  try {
    await contatoProvider.enviarEmail({
      destino: destinoSuporte,
      assunto: interno.assunto,
      html: interno.corpoHtml,
      texto: interno.corpoTexto,
    });
  } catch (err) {
    erroEnvioInterno(err, payloadLog);
    throw new HttpError(503, 'Não foi possível enviar sua mensagem agora. Tente novamente em alguns instantes.');
  }

  const confirmacao = montarEmailContatoPublicoConfirmacao({ nome, assunto });
  try {
    await contatoProvider.enviarEmail({
      destino: email,
      assunto: confirmacao.assunto,
      html: confirmacao.corpoHtml,
      texto: confirmacao.corpoTexto,
    });
  } catch (err) {
    log('warn', 'Falha ao enviar confirmação de contato público ao remetente', {
      email,
      assunto,
      erro: err?.message,
      name: err?.name,
      code: err?.code,
      statusCode: err?.statusCode,
    });
  }

  return { sucesso: true, mensagem: SUCCESS_MESSAGE };
}

export default {
  enviarContatoPublico,
};
