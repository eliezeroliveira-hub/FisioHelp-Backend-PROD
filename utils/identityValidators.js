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

export function isValidCNPJ(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;

  const nums = digits.split('').map(Number);
  const calcDigit = (weights) => {
    const sum = weights.reduce((acc, weight, index) => acc + nums[index] * weight, 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  const dv1 = calcDigit([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (dv1 !== nums[12]) return false;

  const dv2 = calcDigit([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return dv2 === nums[13];
}
