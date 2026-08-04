import { createHash } from 'crypto';

export const PRONTUARIO_SIGNATURE_VERSION = 2;

/**
 * Campos funcionais do prontuário protegidos pela assinatura.
 * A lista cobre toda a informação apresentada no PDF e também o campo de
 * quantidade provável de atendimentos, que integra o registro clínico.
 */
export const PRONTUARIO_SIGNATURE_CONTENT_FIELDS = Object.freeze([
  'DataCriacao',
  'DataUltimaAtualizacao',
  'DataRegistroProcedimentos',
  'PacienteNomeCompleto',
  'PacienteNaturalidade',
  'PacienteEstadoCivil',
  'PacienteGenero',
  'PacienteLocalNascimento',
  'PacienteDataNascimento',
  'PacienteProfissao',
  'PacienteEnderecoComercial',
  'PacienteEnderecoResidencial',
  'PacienteCep',
  'PacienteCepComercial',
  'ProfissionalNome',
  'ProfissionalCrefito',
  'HistoriaClinica',
  'DetalhamentoCaso',
  'PlanoTerapeutico',
  'QueixaPrincipal',
  'HabitosDeVida',
  'HistoriaAtual',
  'HistoriaPregressa',
  'AntecedentesPessoais',
  'AntecedentesFamiliares',
  'TratamentosRealizados',
  'ExameClinicoFisico',
  'ExamesComplementares',
  'DiagnosticoFisioterapeutico',
  'PrognosticoFisioterapeutico',
  'PlanoTerapeuticoDetalhado',
  'QuantidadeProvavelAtendimentos',
  'Evolucao',
  'DataEvolucao',
  'Intercorrencias',
]);

export const PRONTUARIO_SIGNATURE_FIELDS = Object.freeze([
  'Id',
  'PacienteId',
  'FisioterapeutaId',
  ...PRONTUARIO_SIGNATURE_CONTENT_FIELDS,
  'AssinadoEm',
  'AssinadoPorId',
  'IpAssinatura',
  'ProfissionalAssinatura',
]);

function canonicalValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

/**
 * Produz um snapshot determinístico e o respectivo SHA-256.
 * `assinatura` sobrescreve os valores ainda não persistidos no prontuário,
 * permitindo que o hash represente exatamente o estado após a assinatura.
 */
export function criarHashAssinaturaProntuario(prontuario = {}, assinatura = {}) {
  const snapshot = { versao: PRONTUARIO_SIGNATURE_VERSION };

  for (const field of PRONTUARIO_SIGNATURE_FIELDS) {
    const source = Object.prototype.hasOwnProperty.call(assinatura, field)
      ? assinatura
      : prontuario;
    snapshot[field] = canonicalValue(source?.[field]);
  }

  const conteudo = JSON.stringify(snapshot);
  const hash = createHash('sha256').update(conteudo, 'utf8').digest('hex');

  return Object.freeze({
    versao: PRONTUARIO_SIGNATURE_VERSION,
    hash,
    conteudo,
    snapshot: Object.freeze(snapshot),
  });
}

export default {
  PRONTUARIO_SIGNATURE_VERSION,
  PRONTUARIO_SIGNATURE_CONTENT_FIELDS,
  PRONTUARIO_SIGNATURE_FIELDS,
  criarHashAssinaturaProntuario,
};
