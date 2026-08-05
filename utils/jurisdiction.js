import { HttpError } from './httpError.js';

export const ESTADO_CREFITO_IMUTAVEL_MESSAGE =
  'O estado não pode ser alterado após a aprovação do CREFITO. Para solicitar uma alteração, entre em contato com suporte@fisiohelp.com.br.';

export function normalizeUf(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function isTrueBit(value) {
  return value === true || value === 1 || value === '1';
}

export function validarJurisdicaoAtendimentoAtual({
  pacienteEstado,
  fisioterapeutaEstado,
  crefitoVerificado,
} = {}) {
  if (!isTrueBit(crefitoVerificado)) {
    throw new HttpError(
      403,
      'Este fisioterapeuta ainda não pode atender: CREFITO pendente de verificação.'
    );
  }

  const estadoPaciente = normalizeUf(pacienteEstado);
  const estadoFisio = normalizeUf(fisioterapeutaEstado);

  if (!estadoPaciente || !estadoFisio || estadoPaciente !== estadoFisio) {
    throw new HttpError(403, 'Atendimento não permitido (jurisdição diferente).', {
      estadoPaciente,
      estadoFisio,
    });
  }

  return { estadoPaciente, estadoFisio };
}

export default {
  normalizeUf,
  validarJurisdicaoAtendimentoAtual,
};
