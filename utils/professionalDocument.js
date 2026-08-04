import { isValidCNPJ, isValidCPF, normalizeCNPJ } from './identityValidators.js';
import { HttpError } from './httpError.js';

export const PROFESSIONAL_PERSON_TYPES = Object.freeze({
  PF: 'PF',
  PJ: 'PJ',
});

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function normalizeCPF(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function normalizeProfessionalPersonType(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized === PROFESSIONAL_PERSON_TYPES.PF || normalized === PROFESSIONAL_PERSON_TYPES.PJ
    ? normalized
    : null;
}

/**
 * Resolve o documento profissional do fisioterapeuta.
 *
 * Retrocompatibilidade: enquanto clientes antigos não enviam TipoPessoa,
 * CPF isolado infere PF e CNPJ isolado infere PJ.
 */
export function normalizarDocumentoProfissional(input = {}) {
  const tipoRaw = input.TipoPessoa ?? input.tipoPessoa;
  const cpfRaw = input.CPF ?? input.cpf;
  const cnpjRaw = input.CNPJ ?? input.cnpj;

  const cpfInformado = hasValue(cpfRaw);
  const cnpjInformado = hasValue(cnpjRaw);
  const tipoFoiInformado = hasValue(tipoRaw);

  let tipoPessoa = normalizeProfessionalPersonType(tipoRaw);

  if (tipoFoiInformado && !tipoPessoa) {
    throw new HttpError(400, 'TipoPessoa inválido. Informe PF ou PJ.');
  }

  if (!tipoPessoa) {
    if (cpfInformado === cnpjInformado) {
      throw new HttpError(400, 'Informe exatamente um documento profissional: CPF ou CNPJ.');
    }
    tipoPessoa = cpfInformado ? PROFESSIONAL_PERSON_TYPES.PF : PROFESSIONAL_PERSON_TYPES.PJ;
  }

  if (tipoPessoa === PROFESSIONAL_PERSON_TYPES.PF) {
    if (!cpfInformado) {
      throw new HttpError(400, 'CPF é obrigatório para fisioterapeuta PF.');
    }
    if (cnpjInformado) {
      throw new HttpError(400, 'Para cadastro como PF, informe somente o CPF.');
    }

    const cpf = normalizeCPF(cpfRaw);
    if (!isValidCPF(cpf)) {
      throw new HttpError(400, 'CPF inválido.');
    }

    return Object.freeze({
      TipoPessoa: PROFESSIONAL_PERSON_TYPES.PF,
      CPF: cpf,
      CNPJ: null,
      DocumentoTipo: 'CPF',
      DocumentoNormalizado: cpf,
    });
  }

  if (!cnpjInformado) {
    throw new HttpError(400, 'CNPJ é obrigatório para fisioterapeuta PJ.');
  }
  if (cpfInformado) {
    throw new HttpError(400, 'Para cadastro como PJ, informe somente o CNPJ.');
  }

  const cnpj = normalizeCNPJ(cnpjRaw);
  if (!isValidCNPJ(cnpj)) {
    throw new HttpError(400, 'CNPJ inválido.');
  }

  return Object.freeze({
    TipoPessoa: PROFESSIONAL_PERSON_TYPES.PJ,
    CPF: null,
    CNPJ: cnpj,
    DocumentoTipo: 'CNPJ',
    DocumentoNormalizado: cnpj,
  });
}

export default {
  PROFESSIONAL_PERSON_TYPES,
  normalizeCPF,
  normalizeProfessionalPersonType,
  normalizarDocumentoProfissional,
};
