import { HttpError } from './httpError.js';

const OPERATIONS = Object.freeze({
  cadastro: Object.freeze({
    flag: 'NOVOS_CADASTROS_ENABLED',
    codigo: 'NOVOS_CADASTROS_ENCERRADOS',
    mensagem: 'Novos cadastros não estão mais disponíveis porque a FisioHelp está encerrando suas operações.',
  }),
  agendamento: Object.freeze({
    flag: 'NOVOS_AGENDAMENTOS_ENABLED',
    codigo: 'NOVOS_AGENDAMENTOS_ENCERRADOS',
    mensagem: 'Novos agendamentos não estão mais disponíveis porque a FisioHelp está encerrando suas operações.',
  }),
  contratacao: Object.freeze({
    flag: 'NOVAS_CONTRATACOES_ENABLED',
    codigo: 'NOVAS_CONTRATACOES_ENCERRADAS',
    mensagem: 'Novas contratações e pagamentos não estão mais disponíveis porque a FisioHelp está encerrando suas operações.',
  }),
});

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function getDefinition(operation) {
  const definition = OPERATIONS[operation];
  if (!definition) throw new TypeError(`Operação de encerramento desconhecida: ${operation}`);
  return definition;
}

export function readRuntimeFlag(name, env = process.env, defaultValue = true) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultValue;

  const normalized = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  // Fail closed para uma configuração explícita, porém inválida.
  return false;
}

export function isOperationEnabled(operation, env = process.env) {
  const definition = getDefinition(operation);
  return readRuntimeFlag(definition.flag, env, true);
}

export function createOperationDisabledError(operation) {
  const definition = getDefinition(operation);
  const error = new HttpError(403, definition.mensagem, {
    codigo: definition.codigo,
    flag: definition.flag,
  });
  error.code = definition.codigo;
  error.codigo = definition.codigo;
  return error;
}

export function assertOperationEnabled(operation, env = process.env) {
  if (!isOperationEnabled(operation, env)) {
    throw createOperationDisabledError(operation);
  }
}

export function getOperationStatus(env = process.env) {
  return {
    novosCadastros: isOperationEnabled('cadastro', env),
    novosAgendamentos: isOperationEnabled('agendamento', env),
    novasContratacoes: isOperationEnabled('contratacao', env),
    encerramentoEm: String(env?.PLATFORM_CLOSING_DATE || '2026-11-30').trim(),
    suporteAte: String(env?.PLATFORM_SUPPORT_END_DATE || '2026-12-30').trim(),
  };
}

export const OPERATION_CODES = Object.freeze(
  Object.fromEntries(Object.values(OPERATIONS).map(({ codigo }) => [codigo, codigo]))
);

