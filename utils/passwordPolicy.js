import { HttpError } from './httpError.js';

const MIN_PASSWORD_LENGTH = 8;
const SPECIAL_CHAR_RE = /[^A-Za-z0-9]/;
const COMMON_SEQUENCE_SOURCES = [
  '0123456789',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiopasdfghjklzxcvbnm',
];
const COMMON_OR_BREACHED_PASSWORDS = [
  '12345678',
  '123456789',
  '1234567890',
  '12345678910',
  'abc12345',
  'admin123',
  'admin1234',
  'brasil123',
  'fisiohelp123',
  'letmein123',
  'password',
  'password1',
  'password123',
  'password1234',
  'qwerty123',
  'qwerty1234',
  'qwertyui',
  'senha',
  'senha123',
  'senha1234',
  'senha12345',
  'test1234',
  'teste123',
  'teste1234',
  'welcome123',
];
const PREDICTABLE_BASE_WORDS = [
  'abc',
  'admin',
  'brasil',
  'fisiohelp',
  'letmein',
  'password',
  'qwerty',
  'senha',
  'test',
  'teste',
  'welcome',
];

function removeDiacritics(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function normalizePasswordForChecks(password) {
  return removeDiacritics(password)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const COMMON_OR_BREACHED_SET = new Set(
  COMMON_OR_BREACHED_PASSWORDS.map((item) => normalizePasswordForChecks(item))
);

function hasSequentialFragment(normalized) {
  if (!normalized || normalized.length < 4) return false;

  for (const source of COMMON_SEQUENCE_SOURCES) {
    const reversed = source.split('').reverse().join('');
    for (const candidate of [source, reversed]) {
      for (let i = 0; i <= candidate.length - 4; i += 1) {
        if (normalized.includes(candidate.slice(i, i + 4))) {
          return true;
        }
      }
    }
  }

  return false;
}

function hasRepeatedPattern(normalized) {
  if (!normalized) return false;
  if (/^(.)\1{5,}$/.test(normalized)) return true;
  if (/^(.{1,3})\1{2,}$/.test(normalized)) return true;
  return false;
}

export function isCommonOrBreachedPassword(password) {
  const normalized = normalizePasswordForChecks(password);
  if (!normalized) return false;

  if (COMMON_OR_BREACHED_SET.has(normalized)) return true;
  if (hasSequentialFragment(normalized)) return true;
  if (hasRepeatedPattern(normalized)) return true;

  return PREDICTABLE_BASE_WORDS.some((base) => {
    return normalized === base || new RegExp(`^${base}\\d+$`).test(normalized);
  });
}

export function getPasswordPolicyError(password, { fieldLabel = 'Senha' } = {}) {
  const raw = String(password ?? '');

  if (raw.length < MIN_PASSWORD_LENGTH) {
    return `${fieldLabel} deve ter no mínimo ${MIN_PASSWORD_LENGTH} caracteres.`;
  }

  if (!/[A-Z]/.test(raw) || !/[a-z]/.test(raw) || !/\d/.test(raw) || !SPECIAL_CHAR_RE.test(raw)) {
    return `${fieldLabel} deve conter letra maiúscula, minúscula, número e caractere especial.`;
  }

  if (isCommonOrBreachedPassword(raw)) {
    return `${fieldLabel} parece uma senha comum ou uma variação conhecida, mesmo com símbolos ou números. Escolha uma combinação menos previsível.`;
  }

  return null;
}

export function validatePasswordStrength(password, options = {}) {
  const error = getPasswordPolicyError(password, options);
  if (error) throw new HttpError(400, error);
  return String(password ?? '');
}
