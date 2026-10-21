import { agoraBrasilDate, getAppTimeZoneParts } from './appDateTime.js';

export const PACIENTE_ATIVACAO_DADOS_TIPO = 'campanha_ativacao_primeira_consulta_paciente';
export const PACIENTE_ATIVACAO_EMAIL_MODELO = 'ativacao_primeira_consulta_paciente';
export const PACIENTE_ATIVACAO_CICLOS_DIAS = Object.freeze([1, 4, 10]);

const CAMPANHA_ID_PATTERN = /^[a-z0-9-]{3,60}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class PacientePrimeiraConsultaCampaignError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PacientePrimeiraConsultaCampaignError';
    this.code = code;
  }
}

function configError(message) {
  return new PacientePrimeiraConsultaCampaignError(
    'PACIENTE_ATIVACAO_CONFIG_INVALID',
    message
  );
}

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'sim', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'nao', 'não', 'no', 'off'].includes(normalized)) return false;
  throw configError(`Valor booleano inválido: ${value}`);
}

function intEnv(value, fallback, { min, max, name }) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const result = Number.isInteger(parsed) ? parsed : fallback;
  if (!Number.isInteger(result) || result < min || result > max) {
    throw configError(`${name} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return result;
}

function optionalEmail(value, name) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.length > 320 || !EMAIL_PATTERN.test(normalized)) {
    throw configError(`${name} deve conter um e-mail válido.`);
  }
  return normalized;
}

function parseDateOnly(value, name) {
  const normalized = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw configError(`${name} deve usar o formato YYYY-MM-DD.`);
  }
  const [year, month, day] = normalized.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw configError(`${name} contém uma data inválida.`);
  }
  return normalized;
}

function parseJsonArray(value, name, normalizeItem) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError(`${name} contém JSON inválido.`);
  }
  if (!Array.isArray(parsed)) throw configError(`${name} deve ser uma lista.`);
  return [...new Set(parsed.map(normalizeItem))];
}

function parseExcludedIds(value) {
  return parseJsonArray(
    value,
    'PACIENTE_ATIVACAO_PACIENTE_IDS_EXCLUIDOS',
    (item) => {
      const id = Number(item);
      if (!Number.isInteger(id) || id <= 0) {
        throw configError('PACIENTE_ATIVACAO_PACIENTE_IDS_EXCLUIDOS possui um ID inválido.');
      }
      return id;
    }
  );
}

function parseExcludedEmails(value) {
  return parseJsonArray(
    value,
    'PACIENTE_ATIVACAO_PACIENTE_EMAILS_EXCLUIDOS',
    (item) => {
      const email = optionalEmail(item, 'PACIENTE_ATIVACAO_PACIENTE_EMAILS_EXCLUIDOS');
      if (!email) {
        throw configError('PACIENTE_ATIVACAO_PACIENTE_EMAILS_EXCLUIDOS possui um e-mail inválido.');
      }
      return email;
    }
  );
}

function parseTestDomains(value) {
  const domains = String(value ?? 'fisiohelp.com.br')
    .split(',')
    .map((item) => item.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  for (const domain of domains) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      throw configError('PACIENTE_ATIVACAO_DOMINIOS_TESTE contém um domínio inválido.');
    }
  }
  return [...new Set(domains)];
}

function parseHttpsUrl(value, name, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(String(value ?? '').trim());
  } catch {
    throw configError(`${name} contém uma URL inválida.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !allowedHosts.includes(parsed.hostname.toLowerCase())
  ) {
    throw configError(`${name} deve usar HTTPS e um host permitido.`);
  }
  return parsed.toString();
}

function optionalPilotCycle(value, hasPilotEmail) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const cycle = Number(raw);
  if (!hasPilotEmail || !PACIENTE_ATIVACAO_CICLOS_DIAS.includes(cycle)) {
    throw configError(
      'PACIENTE_ATIVACAO_PILOTO_FORCAR_DIA exige um e-mail piloto e deve ser 1, 4 ou 10.'
    );
  }
  return cycle;
}

export function obterHojeBrasilIso(date = new Date()) {
  const parts = getAppTimeZoneParts(date, 'America/Sao_Paulo');
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
  ].join('-');
}

export function carregarConfigPacientePrimeiraConsulta(env = process.env) {
  const enabled = boolEnv(env.PACIENTE_ATIVACAO_WORKER_ENABLED, false);
  if (!enabled) return { enabled: false, emailEnabled: false };

  const emailEnabled = boolEnv(env.PACIENTE_ATIVACAO_EMAIL_ENABLED, true);
  const campanhaId = String(env.PACIENTE_ATIVACAO_CAMPANHA_ID || '').trim();
  if (!CAMPANHA_ID_PATTERN.test(campanhaId)) {
    throw configError(
      'PACIENTE_ATIVACAO_CAMPANHA_ID deve corresponder a [a-z0-9-]{3,60}.'
    );
  }

  const dataInicial = parseDateOnly(
    env.PACIENTE_ATIVACAO_DATA_INICIAL,
    'PACIENTE_ATIVACAO_DATA_INICIAL'
  );
  const pacienteEmailAlvo = optionalEmail(
    env.PACIENTE_ATIVACAO_PACIENTE_EMAIL,
    'PACIENTE_ATIVACAO_PACIENTE_EMAIL'
  );
  const pilotoForcarDia = optionalPilotCycle(
    env.PACIENTE_ATIVACAO_PILOTO_FORCAR_DIA,
    Boolean(pacienteEmailAlvo)
  );
  const pilotoExclusivo = boolEnv(
    env.PACIENTE_ATIVACAO_PILOTO_EXCLUSIVO,
    false
  );
  if (pilotoExclusivo && !pacienteEmailAlvo) {
    throw configError(
      'PACIENTE_ATIVACAO_PILOTO_EXCLUSIVO exige PACIENTE_ATIVACAO_PACIENTE_EMAIL.'
    );
  }

  return {
    enabled,
    emailEnabled,
    campanhaId,
    dataInicial,
    pacienteEmailAlvo,
    pilotoForcarDia,
    pilotoExclusivo,
    pacienteIdsExcluidos: parseExcludedIds(
      env.PACIENTE_ATIVACAO_PACIENTE_IDS_EXCLUIDOS
    ),
    pacienteEmailsExcluidos: parseExcludedEmails(
      env.PACIENTE_ATIVACAO_PACIENTE_EMAILS_EXCLUIDOS
    ),
    dominiosTeste: parseTestDomains(env.PACIENTE_ATIVACAO_DOMINIOS_TESTE),
    batchSize: intEnv(env.PACIENTE_ATIVACAO_BATCH_SIZE, 50, {
      min: 1,
      max: 100,
      name: 'PACIENTE_ATIVACAO_BATCH_SIZE',
    }),
    maxBatches: intEnv(env.PACIENTE_ATIVACAO_MAX_BATCHES, 20, {
      min: 1,
      max: 100,
      name: 'PACIENTE_ATIVACAO_MAX_BATCHES',
    }),
    fisioterapeutasUrl: parseHttpsUrl(
      env.PACIENTE_ATIVACAO_FISIOTERAPEUTAS_URL ||
        'https://fisiohelp.com.br/fisioterapeutas?utm_source=email&utm_medium=crm&utm_campaign=ativacao_primeira_consulta',
      'PACIENTE_ATIVACAO_FISIOTERAPEUTAS_URL',
      ['fisiohelp.com.br', 'www.fisiohelp.com.br']
    ),
    videoUrl: parseHttpsUrl(
      env.PACIENTE_ATIVACAO_VIDEO_URL ||
        'https://www.youtube.com/shorts/p7bcIv3_qJ4',
      'PACIENTE_ATIVACAO_VIDEO_URL',
      ['youtube.com', 'www.youtube.com', 'youtu.be']
    ),
    videoThumbnailUrl: parseHttpsUrl(
      env.PACIENTE_ATIVACAO_VIDEO_THUMBNAIL_URL ||
        'https://img.youtube.com/vi/p7bcIv3_qJ4/maxresdefault.jpg',
      'PACIENTE_ATIVACAO_VIDEO_THUMBNAIL_URL',
      ['img.youtube.com', 'i.ytimg.com']
    ),
    appStoreUrl: parseHttpsUrl(
      env.PACIENTE_ATIVACAO_APP_STORE_URL ||
        'https://apps.apple.com/br/app/fisiohelp/id6794336661',
      'PACIENTE_ATIVACAO_APP_STORE_URL',
      ['apps.apple.com']
    ),
    googlePlayUrl: parseHttpsUrl(
      env.PACIENTE_ATIVACAO_GOOGLE_PLAY_URL ||
        'https://play.google.com/store/apps/details?id=br.com.fisiohelp.app',
      'PACIENTE_ATIVACAO_GOOGLE_PLAY_URL',
      ['play.google.com']
    ),
  };
}

export function obterControleDespachoPacientePrimeiraConsulta(
  env = process.env,
  date = new Date()
) {
  const hojeBrasil = obterHojeBrasilIso(date);
  try {
    const config = carregarConfigPacientePrimeiraConsulta(env);
    return {
      hojeBrasil,
      emailEnabled: config.enabled && config.emailEnabled,
      pilotoExclusivo: config.enabled && config.pilotoExclusivo,
      configError: null,
    };
  } catch (error) {
    return {
      hojeBrasil,
      emailEnabled: false,
      pilotoExclusivo: false,
      configError: error?.message || 'Configuração da ativação de pacientes inválida.',
    };
  }
}

export function criarContextoPacientePrimeiraConsulta(date = new Date()) {
  return {
    agoraBrasil: agoraBrasilDate(date),
    hojeBrasil: obterHojeBrasilIso(date),
  };
}

export default {
  PACIENTE_ATIVACAO_DADOS_TIPO,
  PACIENTE_ATIVACAO_EMAIL_MODELO,
  PACIENTE_ATIVACAO_CICLOS_DIAS,
  PacientePrimeiraConsultaCampaignError,
  carregarConfigPacientePrimeiraConsulta,
  obterControleDespachoPacientePrimeiraConsulta,
  criarContextoPacientePrimeiraConsulta,
};
