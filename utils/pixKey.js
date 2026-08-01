export function normalizarChavePixTelefoneAsaas(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;

  const telefoneComDdd = digits.startsWith('55') && digits.length === 13
    ? digits.slice(2)
    : digits;

  return /^\d{11}$/.test(telefoneComDdd) ? telefoneComDdd : null;
}

export default {
  normalizarChavePixTelefoneAsaas,
};
