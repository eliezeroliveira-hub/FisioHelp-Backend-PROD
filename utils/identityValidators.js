export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isValidEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidCPF(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;

  const nums = digits.split('').map(Number);

  let sum1 = 0;
  for (let i = 0; i < 9; i += 1) sum1 += nums[i] * (10 - i);
  let dv1 = (sum1 * 10) % 11;
  if (dv1 === 10) dv1 = 0;
  if (dv1 !== nums[9]) return false;

  let sum2 = 0;
  for (let i = 0; i < 10; i += 1) sum2 += nums[i] * (11 - i);
  let dv2 = (sum2 * 10) % 11;
  if (dv2 === 10) dv2 = 0;
  if (dv2 !== nums[10]) return false;

  return true;
}

const CNPJ_ZERO = '00000000000000';
const CNPJ_BASE_LENGTH = 12;
const CNPJ_FULL_REGEX = /^[A-Z\d]{12}\d{2}$/;
const CNPJ_BASE_REGEX = /^[A-Z\d]{12}$/;
const CNPJ_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CHAR_CODE_ZERO = '0'.charCodeAt(0);

export function normalizeCNPJ(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[.\-/\s]/g, '');
}

export function calcularDigitosCNPJ(base) {
  const cnpjBase = normalizeCNPJ(base);
  if (!CNPJ_BASE_REGEX.test(cnpjBase) || cnpjBase === CNPJ_ZERO.slice(0, CNPJ_BASE_LENGTH)) {
    throw new Error('CNPJ base inválido.');
  }

  let somaDv1 = 0;
  let somaDv2 = 0;
  for (let i = 0; i < CNPJ_BASE_LENGTH; i += 1) {
    const valor = cnpjBase.charCodeAt(i) - CHAR_CODE_ZERO;
    somaDv1 += valor * CNPJ_WEIGHTS[i + 1];
    somaDv2 += valor * CNPJ_WEIGHTS[i];
  }

  const dv1 = somaDv1 % 11 < 2 ? 0 : 11 - (somaDv1 % 11);
  somaDv2 += dv1 * CNPJ_WEIGHTS[CNPJ_BASE_LENGTH];
  const dv2 = somaDv2 % 11 < 2 ? 0 : 11 - (somaDv2 % 11);
  return `${dv1}${dv2}`;
}

export function isValidCNPJ(value) {
  const cnpj = normalizeCNPJ(value);
  if (!CNPJ_FULL_REGEX.test(cnpj)) return false;
  if (cnpj === CNPJ_ZERO) return false;

  const dvInformado = cnpj.slice(CNPJ_BASE_LENGTH);
  const dvCalculado = calcularDigitosCNPJ(cnpj.slice(0, CNPJ_BASE_LENGTH));
  return dvInformado === dvCalculado;
}

export function isCNPJAlfanumerico(value) {
  const cnpj = normalizeCNPJ(value);
  return /^[A-Z\d]{14}$/.test(cnpj) && /[A-Z]/.test(cnpj);
}

export function formatCNPJ(value) {
  const cnpj = normalizeCNPJ(value);
  if (/^[A-Z\d]{14}$/.test(cnpj)) {
    return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
  }

  const raw = String(value ?? '').trim();
  return raw || null;
}
