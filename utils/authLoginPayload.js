import { isValidCNPJ, normalizeCNPJ } from './identityValidators.js';

function text(value) {
  return String(value ?? '').trim();
}

function onlyDigits(value) {
  return text(value).replace(/\D/g, '');
}

export function buildAuthLoginPayload({ email, cpf, cnpj, login, senha } = {}) {
  const password = String(senha ?? '');
  const explicitEmail = text(email);
  const explicitCpf = text(cpf);
  const explicitCnpj = text(cnpj);

  if (explicitEmail) return { email: explicitEmail, senha: password };
  if (explicitCpf) return { cpf: onlyDigits(explicitCpf), senha: password };
  if (explicitCnpj) return { cnpj: normalizeCNPJ(explicitCnpj), senha: password };

  const identifier = text(login);
  const normalizedCnpj = normalizeCNPJ(identifier);
  if (isValidCNPJ(normalizedCnpj)) {
    return { cnpj: normalizedCnpj, senha: password };
  }

  const digits = onlyDigits(identifier);
  if (digits.length === 11) return { cpf: digits, senha: password };

  return { email: identifier, senha: password };
}
