import { getAppTimeZoneParts } from './appDateTime.js';

function pad2(value) {
  return String(Number(value) || 0).padStart(2, '0');
}

export function normalizarCompetencia(value) {
  const normalized = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})$/.exec(normalized);
  if (!match) return null;

  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? normalized : null;
}

export function obterCompetenciaBrasil(date = new Date()) {
  const parts = getAppTimeZoneParts(date, 'America/Sao_Paulo');
  return `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}`;
}

export function resolverExecucaoCampanha({
  agora = new Date(),
  lancamentoCompetencia = null,
} = {}) {
  const parts = getAppTimeZoneParts(agora, 'America/Sao_Paulo');
  const competencia = `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}`;
  const lancamento = normalizarCompetencia(lancamentoCompetencia) === competencia;
  const inicioDoMes = parts.day === 1;

  return {
    executar: lancamento || inicioDoMes,
    competencia,
    variacao: lancamento ? 'lancamento' : 'mensal',
    diaBrasil: parts.day,
  };
}

export default {
  normalizarCompetencia,
  obterCompetenciaBrasil,
  resolverExecucaoCampanha,
};
