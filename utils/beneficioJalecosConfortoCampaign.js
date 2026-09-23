import { getAppTimeZoneParts } from './appDateTime.js';

export const JALECOS_CONFORTO_DADOS_TIPO = 'campanha_beneficio_jalecos_conforto';
export const JALECOS_CONFORTO_EMAIL_MODELO = 'beneficio_jalecos_conforto_fisioterapeuta';

const CAMPANHA_ID_PATTERN = /^[a-z0-9-]{3,60}$/;
const CUPOM_PATTERN = /^[A-Za-z0-9_-]{3,30}$/;
const DEFAULT_BENEFICIO_URL = 'https://www.jalecosconforto.com.br/';
const DEFAULT_CUPOM = 'FisioHelp';
const ALLOWED_HOSTS = new Set(['jalecosconforto.com.br', 'www.jalecosconforto.com.br']);

export class JalecosConfortoCampaignError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'JalecosConfortoCampaignError';
    this.code = code;
  }
}

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'sim', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'nao', 'não', 'no', 'off'].includes(normalized)) return false;
  throw new JalecosConfortoCampaignError('JALECOS_CONFORTO_CONFIG_INVALID', `Valor booleano inválido: ${value}`);
}

function intEnv(value, fallback, { min, max, name }) {
  const raw = value === undefined || value === null || String(value).trim() === ''
    ? fallback
    : value;
  if (!/^-?\d+$/.test(String(raw).trim())) {
    throw new JalecosConfortoCampaignError(
      'JALECOS_CONFORTO_CONFIG_INVALID',
      `${name} deve ser um inteiro entre ${min} e ${max}.`
    );
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new JalecosConfortoCampaignError(
      'JALECOS_CONFORTO_CONFIG_INVALID',
      `${name} deve ser um inteiro entre ${min} e ${max}.`
    );
  }
  return parsed;
}

function optionalPositiveInt(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  if (!/^\d+$/.test(String(value).trim())) {
    throw new JalecosConfortoCampaignError('JALECOS_CONFORTO_CONFIG_INVALID', `${name} deve ser um ID inteiro positivo.`);
  }
  return intEnv(value, null, { min: 1, max: 2_147_483_647, name });
}

function optionalEmail(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (
    normalized.length > 320 ||
    /\s/.test(normalized) ||
    !/^[^@]+@[^@]+\.[^@]+$/.test(normalized)
  ) {
    throw new JalecosConfortoCampaignError('JALECOS_CONFORTO_CONFIG_INVALID', `${name} deve conter um e-mail válido.`);
  }
  return normalized;
}

function parseExcludedIds(value) {
  if (value === undefined || value === null || String(value).trim() === '') return [];

  let entries;
  const raw = String(value).trim();
  if (raw.startsWith('[')) {
    try {
      entries = JSON.parse(raw);
    } catch {
      throw new JalecosConfortoCampaignError(
        'JALECOS_CONFORTO_CONFIG_INVALID',
        'JALECOS_CONFORTO_FISIOTERAPEUTA_IDS_EXCLUIDOS contém JSON inválido.'
      );
    }
  } else {
    entries = raw.split(',');
  }

  if (!Array.isArray(entries)) {
    throw new JalecosConfortoCampaignError(
      'JALECOS_CONFORTO_CONFIG_INVALID',
      'JALECOS_CONFORTO_FISIOTERAPEUTA_IDS_EXCLUIDOS deve ser uma lista.'
    );
  }

  if (entries.some((entry) => !/^\d+$/.test(String(entry).trim()))) {
    throw new JalecosConfortoCampaignError(
      'JALECOS_CONFORTO_CONFIG_INVALID',
      'JALECOS_CONFORTO_FISIOTERAPEUTA_IDS_EXCLUIDOS possui um ID inválido.'
    );
  }
  const ids = entries.map((entry) => Number.parseInt(String(entry).trim(), 10));
  if (ids.some((id) => !Number.isInteger(id) || id < 1 || id > 2_147_483_647)) {
    throw new JalecosConfortoCampaignError(
      'JALECOS_CONFORTO_CONFIG_INVALID',
      'JALECOS_CONFORTO_FISIOTERAPEUTA_IDS_EXCLUIDOS possui um ID inválido.'
    );
  }
  return [...new Set(ids)];
}

function parseDateOnly(value, name) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new JalecosConfortoCampaignError('JALECOS_CONFORTO_CONFIG_INVALID', `${name} deve usar o formato YYYY-MM-DD.`);
  }

  const [year, month, day] = raw.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new JalecosConfortoCampaignError('JALECOS_CONFORTO_CONFIG_INVALID', `${name} contém uma data inválida.`);
  }
  return raw;
}

function parseHttpsUrl(value, name, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new JalecosConfortoCampaignError('JALECOS_CONFORTO_CONFIG_INVALID', `${name} contém uma URL inválida.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new JalecosConfortoCampaignError('JALECOS_CONFORTO_CONFIG_INVALID', `${name} deve ser uma URL HTTPS sem credenciais.`);
  }
  if (allowedHosts && !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new JalecosConfortoCampaignError('JALECOS_CONFORTO_CONFIG_INVALID', `${name} aponta para um host não permitido.`);
  }
  return parsed.toString();
}

function dateOnlyToEpochDay(value) {
  const [year, month, day] = value.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function epochDayToDateOnly(epochDay) {
  return new Date(epochDay * 86_400_000).toISOString().slice(0, 10);
}

function minDateOnly(first, second) {
  return first <= second ? first : second;
}

export function obterHojeBrasilIso(date = new Date()) {
  const parts = getAppTimeZoneParts(date, 'America/Sao_Paulo');
  return [parts.year, parts.month, parts.day]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
}

function resolverCanal({ hoje, inicio, fim, intervaloDias, toleranciaDias }) {
  const hojeDia = dateOnlyToEpochDay(hoje);
  const inicioDia = dateOnlyToEpochDay(inicio);
  const fimDia = dateOnlyToEpochDay(fim);

  if (hojeDia < inicioDia || hojeDia > fimDia) {
    return { executar: false, ciclo: null, dataPrevista: null, expiraEm: null };
  }

  const diasDesdeInicio = hojeDia - inicioDia;
  const ciclo = Math.floor(diasDesdeInicio / intervaloDias);
  const dataPrevistaDia = inicioDia + (ciclo * intervaloDias);
  const expiraDia = Math.min(dataPrevistaDia + toleranciaDias, fimDia);

  return {
    executar: hojeDia <= expiraDia,
    ciclo,
    dataPrevista: epochDayToDateOnly(dataPrevistaDia),
    expiraEm: epochDayToDateOnly(expiraDia),
  };
}

export function resolverCiclosBeneficioJalecosConforto(config, date = new Date()) {
  const hoje = obterHojeBrasilIso(date);
  const email = resolverCanal({
    hoje,
    inicio: config.dataInicial,
    fim: config.dataFinal,
    intervaloDias: config.emailIntervalDays,
    toleranciaDias: config.toleranciaDias,
  });
  const push = resolverCanal({
    hoje,
    inicio: config.dataInicial,
    fim: config.dataFinal,
    intervaloDias: config.pushIntervalDays,
    toleranciaDias: config.toleranciaDias,
  });

  return {
    hoje,
    dentroDaCampanha: hoje >= config.dataInicial && hoje <= config.dataFinal,
    email: { ...email, variacao: email.ciclo === 0 ? 'lancamento' : 'lembrete' },
    push: { ...push, variacao: push.ciclo === 0 ? 'lancamento' : 'lembrete' },
  };
}

export function carregarConfigBeneficioJalecosConforto(env = process.env) {
  const enabled = boolEnv(env.JALECOS_CONFORTO_WORKER_ENABLED, false);
  if (!enabled) {
    return {
      enabled: false,
      emailEnabled: false,
      pushEnabled: false,
    };
  }

  const emailEnabled = boolEnv(env.JALECOS_CONFORTO_EMAIL_ENABLED, true);
  const pushEnabled = boolEnv(env.JALECOS_CONFORTO_PUSH_ENABLED, true);
  if (!emailEnabled && !pushEnabled) {
    throw new JalecosConfortoCampaignError(
      'JALECOS_CONFORTO_CONFIG_INVALID',
      'Ao menos um canal Jalecos Conforto deve estar habilitado.'
    );
  }

  const campanhaId = String(env.JALECOS_CONFORTO_CAMPANHA_ID || '').trim();
  if (!CAMPANHA_ID_PATTERN.test(campanhaId)) {
    throw new JalecosConfortoCampaignError(
      'JALECOS_CONFORTO_CONFIG_INVALID',
      'JALECOS_CONFORTO_CAMPANHA_ID deve corresponder a [a-z0-9-]{3,60}.'
    );
  }

  const dataInicial = parseDateOnly(
    env.JALECOS_CONFORTO_DATA_INICIAL,
    'JALECOS_CONFORTO_DATA_INICIAL'
  );
  const dataFinal = parseDateOnly(env.JALECOS_CONFORTO_DATA_FINAL, 'JALECOS_CONFORTO_DATA_FINAL');
  if (dataFinal < dataInicial) {
    throw new JalecosConfortoCampaignError(
      'JALECOS_CONFORTO_CONFIG_INVALID',
      'JALECOS_CONFORTO_DATA_FINAL deve ser igual ou posterior à data inicial.'
    );
  }

  const emailIntervalDays = intEnv(env.JALECOS_CONFORTO_EMAIL_INTERVAL_DAYS, 20, {
    min: 1,
    max: 365,
    name: 'JALECOS_CONFORTO_EMAIL_INTERVAL_DAYS',
  });
  const pushIntervalDays = intEnv(env.JALECOS_CONFORTO_PUSH_INTERVAL_DAYS, 10, {
    min: 1,
    max: 365,
    name: 'JALECOS_CONFORTO_PUSH_INTERVAL_DAYS',
  });
  const toleranciaDias = intEnv(env.JALECOS_CONFORTO_TOLERANCIA_DIAS, 3, {
    min: 0,
    max: 30,
    name: 'JALECOS_CONFORTO_TOLERANCIA_DIAS',
  });
  if (toleranciaDias >= emailIntervalDays || toleranciaDias >= pushIntervalDays) {
    throw new JalecosConfortoCampaignError(
      'JALECOS_CONFORTO_CONFIG_INVALID',
      'A tolerância deve ser menor que os intervalos de e-mail e push.'
    );
  }

  const cupom = String(env.JALECOS_CONFORTO_CUPOM || DEFAULT_CUPOM).trim();
  if (!CUPOM_PATTERN.test(cupom)) {
    throw new JalecosConfortoCampaignError(
      'JALECOS_CONFORTO_CONFIG_INVALID',
      'JALECOS_CONFORTO_CUPOM deve corresponder a [A-Za-z0-9_-]{3,30}.'
    );
  }

  const fisioterapeutaIdAlvo = optionalPositiveInt(
    env.JALECOS_CONFORTO_FISIOTERAPEUTA_ID,
    'JALECOS_CONFORTO_FISIOTERAPEUTA_ID'
  );
  const fisioterapeutaEmailAlvo = optionalEmail(
    env.JALECOS_CONFORTO_FISIOTERAPEUTA_EMAIL,
    'JALECOS_CONFORTO_FISIOTERAPEUTA_EMAIL'
  );
  if (fisioterapeutaIdAlvo && fisioterapeutaEmailAlvo) {
    throw new JalecosConfortoCampaignError(
      'JALECOS_CONFORTO_CONFIG_INVALID',
      'Configure somente um alvo piloto: ID ou e-mail do fisioterapeuta.'
    );
  }

  return {
    enabled,
    emailEnabled,
    pushEnabled,
    campanhaId,
    dataInicial,
    dataFinal,
    emailIntervalDays,
    pushIntervalDays,
    toleranciaDias,
    batchSize: intEnv(env.JALECOS_CONFORTO_BATCH_SIZE, 50, {
      min: 1,
      max: 100,
      name: 'JALECOS_CONFORTO_BATCH_SIZE',
    }),
    maxBatches: intEnv(env.JALECOS_CONFORTO_MAX_BATCHES, 20, {
      min: 1,
      max: 100,
      name: 'JALECOS_CONFORTO_MAX_BATCHES',
    }),
    fisioterapeutaIdAlvo,
    fisioterapeutaEmailAlvo,
    fisioterapeutaIdsExcluidos: parseExcludedIds(
      env.JALECOS_CONFORTO_FISIOTERAPEUTA_IDS_EXCLUIDOS
    ),
    beneficioUrl: parseHttpsUrl(
      env.JALECOS_CONFORTO_URL || DEFAULT_BENEFICIO_URL,
      'JALECOS_CONFORTO_URL',
      ALLOWED_HOSTS
    ),
    cupom,
    linkCheckTimeoutMs: intEnv(env.JALECOS_CONFORTO_LINK_CHECK_TIMEOUT_MS, 5_000, {
      min: 1_000,
      max: 30_000,
      name: 'JALECOS_CONFORTO_LINK_CHECK_TIMEOUT_MS',
    }),
  };
}

export function obterControleDespachoBeneficioJalecosConforto(env = process.env, date = new Date()) {
  const hojeBrasil = obterHojeBrasilIso(date);
  try {
    const config = carregarConfigBeneficioJalecosConforto(env);
    return {
      hojeBrasil,
      emailEnabled: config.enabled && config.emailEnabled,
      pushEnabled: config.enabled && config.pushEnabled,
      configError: null,
    };
  } catch (error) {
    return {
      hojeBrasil,
      emailEnabled: false,
      pushEnabled: false,
      configError: error?.message || 'Configuração Jalecos Conforto inválida.',
    };
  }
}

function validarUrlAntesDaRequisicao(value, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new JalecosConfortoCampaignError('JALECOS_CONFORTO_LINK_CHECK_FAILED', 'A verificação encontrou uma URL inválida.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !allowedHosts.has(parsed.hostname.toLowerCase())
  ) {
    throw new JalecosConfortoCampaignError(
      'JALECOS_CONFORTO_LINK_CHECK_FAILED',
      'A verificação encontrou um destino não permitido.'
    );
  }
  return parsed;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function verificarLinksBeneficioJalecosConforto(config, { fetchImpl = fetch } = {}) {
  const beneficioUrl = validarUrlAntesDaRequisicao(config.beneficioUrl, ALLOWED_HOSTS);
  let response = await fetchWithTimeout(
    fetchImpl,
    beneficioUrl,
    { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': 'FisioHelp-LinkCheck/1.0' } },
    config.linkCheckTimeoutMs
  );
  if (response.status === 405 || response.status === 501) {
    response = await fetchWithTimeout(
      fetchImpl,
      beneficioUrl,
      { method: 'GET', redirect: 'manual', headers: { 'user-agent': 'FisioHelp-LinkCheck/1.0' } },
      config.linkCheckTimeoutMs
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new JalecosConfortoCampaignError(
      'JALECOS_CONFORTO_LINK_CHECK_FAILED',
      'O site da Jalecos Conforto não respondeu com sucesso e sem redirecionamento.'
    );
  }

  return { ok: true };
}

export function calcularDataFinalInclusiva(dataInicial, dias) {
  const inicio = parseDateOnly(dataInicial, 'dataInicial');
  const totalDias = intEnv(dias, null, { min: 0, max: 3_650, name: 'dias' });
  return epochDayToDateOnly(dateOnlyToEpochDay(inicio) + totalDias);
}

export function limitarExpiracaoAoFim(dataPrevista, toleranciaDias, dataFinal) {
  return minDateOnly(
    epochDayToDateOnly(dateOnlyToEpochDay(dataPrevista) + toleranciaDias),
    dataFinal
  );
}

export default {
  JALECOS_CONFORTO_DADOS_TIPO,
  JALECOS_CONFORTO_EMAIL_MODELO,
  JalecosConfortoCampaignError,
  carregarConfigBeneficioJalecosConforto,
  obterControleDespachoBeneficioJalecosConforto,
  obterHojeBrasilIso,
  resolverCiclosBeneficioJalecosConforto,
  verificarLinksBeneficioJalecosConforto,
  calcularDataFinalInclusiva,
  limitarExpiracaoAoFim,
};
