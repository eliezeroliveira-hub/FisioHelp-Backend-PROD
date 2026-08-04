import {
  isCNPJAlfanumerico,
  isValidCNPJ,
  isValidCPF,
  isValidEmail,
  normalizeCNPJ,
  normalizeEmail,
} from './identityValidators.js';
import { HttpError } from './httpError.js';
import { CNPJ_ALFANUMERICO_REPASSE_MSG } from './professionalFinancial.js';

const PIX_TIPOS_VALIDOS = new Set(['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP']);

export function normalizarChavePixTelefoneAsaas(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;

  const telefoneComDdd = digits.startsWith('55') && digits.length === 13
    ? digits.slice(2)
    : digits;

  return /^\d{11}$/.test(telefoneComDdd) ? telefoneComDdd : null;
}

export function normalizarTipoChavePixAsaas(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return null;
  if (raw === 'TELEFONE' || raw === 'CELULAR') return 'PHONE';
  if (raw === 'ALEATORIA' || raw === 'ALEATÓRIA' || raw === 'CHAVE_ALEATORIA') return 'EVP';
  return PIX_TIPOS_VALIDOS.has(raw) ? raw : null;
}

export function normalizarChavePixAsaas(tipo, value) {
  const tipoNormalizado = normalizarTipoChavePixAsaas(tipo);
  const raw = String(value ?? '').trim();
  if (!tipoNormalizado || !raw) {
    throw new HttpError(400, 'Tipo e chave Pix são obrigatórios.');
  }

  if (tipoNormalizado === 'CPF') {
    const cpf = raw.replace(/\D/g, '');
    if (!isValidCPF(cpf)) throw new HttpError(400, 'Chave Pix CPF inválida.');
    return cpf;
  }

  if (tipoNormalizado === 'CNPJ') {
    const cnpj = normalizeCNPJ(raw);
    if (!isValidCNPJ(cnpj)) throw new HttpError(400, 'Chave Pix CNPJ inválida.');
    if (isCNPJAlfanumerico(cnpj)) throw new HttpError(400, CNPJ_ALFANUMERICO_REPASSE_MSG);
    return cnpj;
  }

  if (tipoNormalizado === 'EMAIL') {
    const email = normalizeEmail(raw);
    if (!isValidEmail(email)) throw new HttpError(400, 'Chave Pix e-mail inválida.');
    return email;
  }

  if (tipoNormalizado === 'PHONE') {
    const phone = normalizarChavePixTelefoneAsaas(raw);
    if (!phone) {
      throw new HttpError(400, 'Chave Pix telefone inválida. Use DDD + número de celular com 11 dígitos.');
    }
    return phone;
  }

  const evp = raw.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(evp)) {
    throw new HttpError(400, 'Chave Pix aleatória inválida. Informe a chave no formato UUID.');
  }
  return evp;
}

export default {
  normalizarChavePixTelefoneAsaas,
  normalizarTipoChavePixAsaas,
  normalizarChavePixAsaas,
};
