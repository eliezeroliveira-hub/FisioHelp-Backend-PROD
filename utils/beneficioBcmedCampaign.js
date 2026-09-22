import crypto from 'node:crypto';

import { getAppTimeZoneParts } from './appDateTime.js';

export const BCMED_DADOS_TIPO = 'campanha_beneficio_bcmed';
export const BCMED_EMAIL_MODELO = 'beneficio_bcmed_fisioterapeuta';

const CAMPANHA_ID_PATTERN = /^[a-z0-9-]{3,60}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const DEFAULT_BCMED_URL = 'https://www.bcmed.com.br/fisioterapia';
const DEFAULT_BENEFICIO_URL = 'https://seudia.de/FisioHelp';
const DEFAULT_WHATSAPP_HOSTS = ['api.whatsapp.com', 'wa.me', 'web.whatsapp.com'];

export class BcmedCampaignError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'BcmedCampaignError';
    this.code = code;
  }
}

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'sim', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'nao', 'não', 'no', 'off'].includes(normalized)) return false;
  throw new BcmedCampaignError('BCMED_CONFIG_INVALID', `Valor booleano inválido: ${value}`);
}

function intEnv(value, fallback, { min, max, name }) {
  const raw = value === undefined || value === null || String(value).trim() === ''
    ? fallback
    : value;
  if (!/^-?\d+$/.test(String(raw).trim())) {
    throw new BcmedCampaignError(
      'BCMED_CONFIG_INVALID',
      `${name} deve ser um inteiro entre ${min} e ${max}.`
    );
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new BcmedCampaignError(
      'BCMED_CONFIG_INVALID',
      `${name} deve ser um inteiro entre ${min} e ${max}.`
    );
  }
  return parsed;
}

function optionalPositiveInt(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  if (!/^\d+$/.test(String(value).trim())) {
    throw new BcmedCampaignError('BCMED_CONFIG_INVALID', `${name} deve ser um ID inteiro positivo.`);
  }
  return intEnv(value, null, { min: 1, max: 2_147_483_647, name });
}

function parseExcludedIds(value) {
  if (value === undefined || value === null || String(value).trim() === '') return [];

  let entries;
  const raw = String(value).trim();
  if (raw.startsWith('[')) {
    try {
      entries = JSON.parse(raw);
    } catch {
      throw new BcmedCampaignError(
        'BCMED_CONFIG_INVALID',
        'BCMED_BENEFICIO_FISIOTERAPEUTA_IDS_EXCLUIDOS contém JSON inválido.'
      );
    }
  } else {
    entries = raw.split(',');
  }

  if (!Array.isArray(entries)) {
    throw new BcmedCampaignError(
      'BCMED_CONFIG_INVALID',
      'BCMED_BENEFICIO_FISIOTERAPEUTA_IDS_EXCLUIDOS deve ser uma lista.'
    );
  }

  if (entries.some((entry) => !/^\d+$/.test(String(entry).trim()))) {
    throw new BcmedCampaignError(
      'BCMED_CONFIG_INVALID',
      'BCMED_BENEFICIO_FISIOTERAPEUTA_IDS_EXCLUIDOS possui um ID inválido.'
    );
  }
  const ids = entries.map((entry) => Number.parseInt(String(entry).trim(), 10));
  if (ids.some((id) => !Number.isInteger(id) || id < 1 || id > 2_147_483_647)) {
    throw new BcmedCampaignError(
      'BCMED_CONFIG_INVALID',
      'BCMED_BENEFICIO_FISIOTERAPEUTA_IDS_EXCLUIDOS possui um ID inválido.'
    );
  }
  return [...new Set(ids)];
}

function parseDateOnly(value, name) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new BcmedCampaignError('BCMED_CONFIG_INVALID', `${name} deve usar o formato YYYY-MM-DD.`);
  }

  const [year, month, day] = raw.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new BcmedCampaignError('BCMED_CONFIG_INVALID', `${name} contém uma data inválida.`);
  }
  return raw;
}

function parseHttpsUrl(value, name, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new BcmedCampaignError('BCMED_CONFIG_INVALID', `${name} contém uma URL inválida.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new BcmedCampaignError('BCMED_CONFIG_INVALID', `${name} deve ser uma URL HTTPS sem credenciais.`);
  }
  if (allowedHosts && !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new BcmedCampaignError('BCMED_CONFIG_INVALID', `${name} aponta para um host não permitido.`);
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

export function resolverCiclosBeneficioBcmed(config, date = new Date()) {
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

export function carregarConfigBeneficioBcmed(env = process.env) {
  const enabled = boolEnv(env.BCMED_BENEFICIO_WORKER_ENABLED, false);
  if (!enabled) {
    return {
      enabled: false,
      emailEnabled: false,
      pushEnabled: false,
    };
  }

  const emailEnabled = boolEnv(env.BCMED_BENEFICIO_EMAIL_ENABLED, true);
  const pushEnabled = boolEnv(env.BCMED_BENEFICIO_PUSH_ENABLED, true);
  if (!emailEnabled && !pushEnabled) {
    throw new BcmedCampaignError(
      'BCMED_CONFIG_INVALID',
      'Ao menos um canal BCMED deve estar habilitado.'
    );
  }

  const campanhaId = String(env.BCMED_BENEFICIO_CAMPANHA_ID || '').trim();
  if (!CAMPANHA_ID_PATTERN.test(campanhaId)) {
    throw new BcmedCampaignError(
      'BCMED_CONFIG_INVALID',
      'BCMED_BENEFICIO_CAMPANHA_ID deve corresponder a [a-z0-9-]{3,60}.'
    );
  }

  const dataInicial = parseDateOnly(
    env.BCMED_BENEFICIO_DATA_INICIAL,
    'BCMED_BENEFICIO_DATA_INICIAL'
  );
  const dataFinal = parseDateOnly(env.BCMED_BENEFICIO_DATA_FINAL, 'BCMED_BENEFICIO_DATA_FINAL');
  if (dataFinal < dataInicial) {
    throw new BcmedCampaignError(
      'BCMED_CONFIG_INVALID',
      'BCMED_BENEFICIO_DATA_FINAL deve ser igual ou posterior à data inicial.'
    );
  }

  const emailIntervalDays = intEnv(env.BCMED_BENEFICIO_EMAIL_INTERVAL_DAYS, 20, {
    min: 1,
    max: 365,
    name: 'BCMED_BENEFICIO_EMAIL_INTERVAL_DAYS',
  });
  const pushIntervalDays = intEnv(env.BCMED_BENEFICIO_PUSH_INTERVAL_DAYS, 10, {
    min: 1,
    max: 365,
    name: 'BCMED_BENEFICIO_PUSH_INTERVAL_DAYS',
  });
  const toleranciaDias = intEnv(env.BCMED_BENEFICIO_TOLERANCIA_DIAS, 3, {
    min: 0,
    max: 30,
    name: 'BCMED_BENEFICIO_TOLERANCIA_DIAS',
  });
  if (toleranciaDias >= emailIntervalDays || toleranciaDias >= pushIntervalDays) {
    throw new BcmedCampaignError(
      'BCMED_CONFIG_INVALID',
      'A tolerância deve ser menor que os intervalos de e-mail e push.'
    );
  }

  const whatsappPhoneSha256 = String(env.BCMED_BENEFICIO_WHATSAPP_PHONE_SHA256 || '')
    .trim()
    .toLowerCase();
  if (!SHA256_PATTERN.test(whatsappPhoneSha256)) {
    throw new BcmedCampaignError(
      'BCMED_CONFIG_INVALID',
      'BCMED_BENEFICIO_WHATSAPP_PHONE_SHA256 deve conter um SHA-256 hexadecimal.'
    );
  }

  const whatsappHosts = new Set(
    String(env.BCMED_BENEFICIO_WHATSAPP_HOSTS || DEFAULT_WHATSAPP_HOSTS.join(','))
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );
  if (whatsappHosts.size === 0) {
    throw new BcmedCampaignError('BCMED_CONFIG_INVALID', 'A lista de hosts do WhatsApp está vazia.');
  }
  if ([...whatsappHosts].some((host) => !DEFAULT_WHATSAPP_HOSTS.includes(host))) {
    throw new BcmedCampaignError(
      'BCMED_CONFIG_INVALID',
      'A lista contém um host do WhatsApp não permitido.'
    );
  }

  const whatsappMessageToken = String(
    env.BCMED_BENEFICIO_WHATSAPP_MESSAGE_TOKEN || 'FisioHelp'
  ).trim();
  if (!whatsappMessageToken) {
    throw new BcmedCampaignError(
      'BCMED_CONFIG_INVALID',
      'BCMED_BENEFICIO_WHATSAPP_MESSAGE_TOKEN não pode ficar vazio.'
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
    batchSize: intEnv(env.BCMED_BENEFICIO_BATCH_SIZE, 50, {
      min: 1,
      max: 100,
      name: 'BCMED_BENEFICIO_BATCH_SIZE',
    }),
    maxBatches: intEnv(env.BCMED_BENEFICIO_MAX_BATCHES, 20, {
      min: 1,
      max: 100,
      name: 'BCMED_BENEFICIO_MAX_BATCHES',
    }),
    fisioterapeutaIdAlvo: optionalPositiveInt(
      env.BCMED_BENEFICIO_FISIOTERAPEUTA_ID,
      'BCMED_BENEFICIO_FISIOTERAPEUTA_ID'
    ),
    fisioterapeutaIdsExcluidos: parseExcludedIds(
      env.BCMED_BENEFICIO_FISIOTERAPEUTA_IDS_EXCLUIDOS
    ),
    bcmedUrl: parseHttpsUrl(
      env.BCMED_BENEFICIO_BCMED_URL || DEFAULT_BCMED_URL,
      'BCMED_BENEFICIO_BCMED_URL',
      new Set(['bcmed.com.br', 'www.bcmed.com.br'])
    ),
    beneficioUrl: parseHttpsUrl(
      env.BCMED_BENEFICIO_URL || DEFAULT_BENEFICIO_URL,
      'BCMED_BENEFICIO_URL',
      new Set(['seudia.de'])
    ),
    whatsappHosts,
    whatsappPhoneSha256,
    whatsappMessageToken,
    linkCheckTimeoutMs: intEnv(env.BCMED_BENEFICIO_LINK_CHECK_TIMEOUT_MS, 5_000, {
      min: 1_000,
      max: 30_000,
      name: 'BCMED_BENEFICIO_LINK_CHECK_TIMEOUT_MS',
    }),
  };
}

export function obterControleDespachoBeneficioBcmed(env = process.env, date = new Date()) {
  const hojeBrasil = obterHojeBrasilIso(date);
  try {
    const config = carregarConfigBeneficioBcmed(env);
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
      configError: error?.message || 'Configuração BCMED inválida.',
    };
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validarUrlAntesDaRequisicao(value, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new BcmedCampaignError('BCMED_LINK_CHECK_FAILED', 'A verificação encontrou uma URL inválida.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !allowedHosts.has(parsed.hostname.toLowerCase())
  ) {
    throw new BcmedCampaignError(
      'BCMED_LINK_CHECK_FAILED',
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

async function obterRedirectManual(fetchImpl, url, timeoutMs) {
  let response = await fetchWithTimeout(
    fetchImpl,
    url,
    { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': 'FisioHelp-LinkCheck/1.0' } },
    timeoutMs
  );
  let location = response.headers?.get?.('location');
  if (!location && (response.status === 405 || response.status === 501 || response.ok)) {
    response = await fetchWithTimeout(
      fetchImpl,
      url,
      { method: 'GET', redirect: 'manual', headers: { 'user-agent': 'FisioHelp-LinkCheck/1.0' } },
      timeoutMs
    );
    location = response.headers?.get?.('location');
  }
  if (response.status < 300 || response.status >= 400 || !location) {
    throw new BcmedCampaignError(
      'BCMED_LINK_CHECK_FAILED',
      'O link do benefício não retornou o redirecionamento esperado.'
    );
  }
  return new URL(location, url).toString();
}

function obterTelefoneWhatsapp(url) {
  const queryPhone = url.searchParams.get('phone');
  const pathPhone = url.hostname.toLowerCase() === 'wa.me'
    ? url.pathname.split('/').filter(Boolean)[0]
    : null;
  return String(queryPhone || pathPhone || '').replace(/\D/g, '');
}

export async function verificarLinksBeneficioBcmed(config, { fetchImpl = fetch } = {}) {
  const bcmedAllowedHosts = new Set(['bcmed.com.br', 'www.bcmed.com.br']);
  const shortAllowedHosts = new Set(['seudia.de']);
  const bcmedUrl = validarUrlAntesDaRequisicao(config.bcmedUrl, bcmedAllowedHosts);
  const beneficioUrl = validarUrlAntesDaRequisicao(config.beneficioUrl, shortAllowedHosts);

  const bcmedResponse = await fetchWithTimeout(
    fetchImpl,
    bcmedUrl,
    { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': 'FisioHelp-LinkCheck/1.0' } },
    config.linkCheckTimeoutMs
  );
  if (bcmedResponse.status < 200 || bcmedResponse.status >= 300) {
    throw new BcmedCampaignError(
      'BCMED_LINK_CHECK_FAILED',
      'A página institucional da BCMED não respondeu com sucesso.'
    );
  }

  const destination = await obterRedirectManual(
    fetchImpl,
    beneficioUrl,
    config.linkCheckTimeoutMs
  );
  const whatsappUrl = validarUrlAntesDaRequisicao(destination, config.whatsappHosts);
  const phone = obterTelefoneWhatsapp(whatsappUrl);
  if (!phone || sha256(phone) !== config.whatsappPhoneSha256) {
    throw new BcmedCampaignError(
      'BCMED_LINK_CHECK_FAILED',
      'O número de destino do benefício não corresponde ao esperado.'
    );
  }

  const message = whatsappUrl.searchParams.get('text') || '';
  if (!message.toLocaleLowerCase('pt-BR').includes(config.whatsappMessageToken.toLocaleLowerCase('pt-BR'))) {
    throw new BcmedCampaignError(
      'BCMED_LINK_CHECK_FAILED',
      'A mensagem do WhatsApp não contém a identificação esperada.'
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
  BCMED_DADOS_TIPO,
  BCMED_EMAIL_MODELO,
  BcmedCampaignError,
  carregarConfigBeneficioBcmed,
  obterControleDespachoBeneficioBcmed,
  obterHojeBrasilIso,
  resolverCiclosBeneficioBcmed,
  verificarLinksBeneficioBcmed,
  calcularDataFinalInclusiva,
  limitarExpiracaoAoFim,
};
