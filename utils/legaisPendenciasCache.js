const CACHE = new Map();

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const TTL_MS = parsePositiveInt(process.env.LEGAIS_PENDENCIAS_CACHE_TTL_MS, 5 * 60 * 1000);
const MAX_ENTRIES = parsePositiveInt(process.env.LEGAIS_PENDENCIAS_CACHE_MAX, 10000);

function normalizeUserId(userId) {
  const n = Number(userId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function pruneExpired(now = Date.now()) {
  for (const [key, value] of CACHE.entries()) {
    if (!value?.expiresAt || value.expiresAt <= now) {
      CACHE.delete(key);
    }
  }
}

function pruneIfOversized() {
  if (CACHE.size < MAX_ENTRIES) return;
  pruneExpired();
  if (CACHE.size < MAX_ENTRIES) return;

  const firstKey = CACHE.keys().next()?.value;
  if (firstKey !== undefined) CACHE.delete(firstKey);
}

export function getLegaisPendenciasCache(userId) {
  const uid = normalizeUserId(userId);
  if (!uid) return null;

  const cached = CACHE.get(uid);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    CACHE.delete(uid);
    return null;
  }

  return cached;
}

export function setLegaisPendenciasCache(userId, payload) {
  const uid = normalizeUserId(userId);
  if (!uid) return;

  pruneIfOversized();

  CACHE.set(uid, {
    temPendencia: Boolean(payload?.temPendencia),
    pendencias: Array.isArray(payload?.pendencias) ? payload.pendencias : [],
    expiresAt: Date.now() + TTL_MS
  });
}

export function invalidateLegaisPendenciasCache(userId) {
  const uid = normalizeUserId(userId);
  if (!uid) return;
  CACHE.delete(uid);
}
