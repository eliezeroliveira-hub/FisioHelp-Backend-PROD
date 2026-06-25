// middleware/loginLimiter.js
import { log } from '../config/logger.js';
import { getClientIp } from '../utils/clientIp.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_ATTEMPTS_BY_IP = Number(process.env.LOGIN_RATE_LIMIT_IP_MAX || 30);
const STORE_MODE = String(process.env.LOGIN_RATE_LIMIT_STORE || 'memory').trim().toLowerCase();
const REDIS_PREFIX = String(process.env.LOGIN_RATE_LIMIT_REDIS_PREFIX || 'rl:login');

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const attemptsByKey = new Map();
const attemptsByIp = new Map();
const PRUNE_EVERY_N_CALLS = parsePositiveInt(process.env.LOGIN_RATE_LIMIT_PRUNE_EVERY, 100);
const PRUNE_MIN_INTERVAL_MS = parsePositiveInt(process.env.LOGIN_RATE_LIMIT_PRUNE_INTERVAL_MS, 30_000);
let memoryLimiterCalls = 0;
let lastPruneAt = 0;
let redisClient = null;
let redisInitPromise = null;
let redisWarned = false;


function normalizeIdentifier(req) {
  const body = req?.body || {};
  const raw = body.email || body.login || body.cpf || body.cnpj || '';
  const v = String(raw).trim().toLowerCase();
  return v || 'sem-identificador';
}

function makeKey(req) {
  const ip = getClientIp(req);
  const identifier = normalizeIdentifier(req);
  return `${ip}::${identifier}`;
}

function makeIpKey(req) {
  return getClientIp(req);
}

function safeRedisToken(v) {
  return encodeURIComponent(String(v || ''));
}

function redisKeyForLoginKey(key) {
  return `${REDIS_PREFIX}:key:${safeRedisToken(key)}`;
}

function redisKeyForIp(ip) {
  return `${REDIS_PREFIX}:ip:${safeRedisToken(ip)}`;
}

async function getRedisClient() {
  if (STORE_MODE !== 'redis') return null;
  if (redisClient) return redisClient;
  if (redisInitPromise) return redisInitPromise;

  redisInitPromise = (async () => {
    try {
      const mod = await import('redis');
      const createClient = mod?.createClient;
      if (typeof createClient !== 'function') throw new Error('Pacote redis inválido.');

      const url = process.env.REDIS_URL || undefined;
      const client = createClient(url ? { url } : {});
      client.on('error', (err) => {
        if (!redisWarned) {
          log('warn', '[loginLimiter] Redis indisponível. Fallback para memória.', {
            erro: err?.message || err
          });
          redisWarned = true;
        }
      });

      await client.connect();
      redisClient = client;
      return redisClient;
    } catch (err) {
      if (!redisWarned) {
        log('warn', '[loginLimiter] STORE=redis configurado, mas Redis não pôde ser inicializado. Usando memória.', {
          erro: err?.message || err
        });
        redisWarned = true;
      }
      return null;
    }
  })();

  try {
    return await redisInitPromise;
  } finally {
    redisInitPromise = null;
  }
}

function getBucket(store, key, now) {
  const current = store.get(key);
  if (!current || now - current.windowStart >= WINDOW_MS) {
    const fresh = { count: 0, windowStart: now };
    store.set(key, fresh);
    return fresh;
  }
  return current;
}

function pruneOld(now) {
  for (const [key, entry] of attemptsByKey.entries()) {
    if (now - entry.windowStart >= WINDOW_MS) attemptsByKey.delete(key);
  }
  for (const [ip, entry] of attemptsByIp.entries()) {
    if (now - entry.windowStart >= WINDOW_MS) attemptsByIp.delete(ip);
  }
}

function maybePrune(now) {
  memoryLimiterCalls += 1;
  const byCalls = memoryLimiterCalls % PRUNE_EVERY_N_CALLS === 0;
  const byTime = now - lastPruneAt >= PRUNE_MIN_INTERVAL_MS;

  if (!byCalls && !byTime) return;
  pruneOld(now);
  lastPruneAt = now;
}

function formatPtBr(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const br = new Date(d.getTime() - (3 * 60 * 60 * 1000));
  const dd = String(br.getUTCDate()).padStart(2, '0');
  const mm = String(br.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = br.getUTCFullYear();
  const hh = String(br.getUTCHours()).padStart(2, '0');
  const mi = String(br.getUTCMinutes()).padStart(2, '0');
  const ss = String(br.getUTCSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy}, ${hh}:${mi}:${ss}`;
}

function getRetryMessage(retryAtMs) {
  const retryAtFmt = formatPtBr(retryAtMs);
  return retryAtFmt
    ? `Muitas tentativas. Tente novamente após ${retryAtFmt}.`
    : 'Muitas tentativas. Aguarde 15 minutos.';
}

function loginLimiterMemory(req, res, next) {
  const now = Date.now();
  maybePrune(now);

  const key = makeKey(req);
  const ipKey = makeIpKey(req);
  const bucket = getBucket(attemptsByKey, key, now);
  const ipBucket = getBucket(attemptsByIp, ipKey, now);

  if (ipBucket.count >= MAX_ATTEMPTS_BY_IP || bucket.count >= MAX_ATTEMPTS) {
    const retryAt = bucket.windowStart + WINDOW_MS;
    return res.status(429).json({ erro: getRetryMessage(retryAt) });
  }

  res.on('finish', () => {
    // skipSuccessfulRequests = true
    if (res.statusCode < 400) return;

    const currentNow = Date.now();
    const currentBucket = getBucket(attemptsByKey, key, currentNow);
    const currentIpBucket = getBucket(attemptsByIp, ipKey, currentNow);
    currentBucket.count += 1;
    currentIpBucket.count += 1;
    attemptsByKey.set(key, currentBucket);
    attemptsByIp.set(ipKey, currentIpBucket);
  });

  return next();
}

async function loginLimiterRedis(req, res, next) {
  const client = await getRedisClient();
  if (!client) return loginLimiterMemory(req, res, next);

  const key = makeKey(req);
  const ipKey = makeIpKey(req);
  const redisKey = redisKeyForLoginKey(key);
  const redisIpKey = redisKeyForIp(ipKey);

  try {
    const [keyCountRaw, ipCountRaw, keyPttlRaw, ipPttlRaw] = await Promise.all([
      client.get(redisKey),
      client.get(redisIpKey),
      client.pTTL(redisKey),
      client.pTTL(redisIpKey)
    ]);

    const keyCount = Number.parseInt(keyCountRaw || '0', 10) || 0;
    const ipCount = Number.parseInt(ipCountRaw || '0', 10) || 0;

    if (ipCount >= MAX_ATTEMPTS_BY_IP || keyCount >= MAX_ATTEMPTS) {
      const keyPttl = Number(keyPttlRaw);
      const ipPttl = Number(ipPttlRaw);
      const retryMs = Math.max(keyPttl > 0 ? keyPttl : 0, ipPttl > 0 ? ipPttl : 0);
      const retryAt = Date.now() + (retryMs > 0 ? retryMs : WINDOW_MS);
      return res.status(429).json({ erro: getRetryMessage(retryAt) });
    }

    res.on('finish', () => {
      if (res.statusCode < 400) return;

      // fire-and-forget para não atrasar resposta
      (async () => {
        try {
          const countByKey = await client.incr(redisKey);
          if (countByKey === 1) await client.pExpire(redisKey, WINDOW_MS);

          const countByIp = await client.incr(redisIpKey);
          if (countByIp === 1) await client.pExpire(redisIpKey, WINDOW_MS);
        } catch {
          // silêncio intencional: fallback natural no próximo request
        }
      })();
    });

    return next();
  } catch {
    return loginLimiterMemory(req, res, next);
  }
}

export async function loginLimiter(req, res, next) {
  if (STORE_MODE === 'redis') {
    return loginLimiterRedis(req, res, next);
  }
  return loginLimiterMemory(req, res, next);
}

