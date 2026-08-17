import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';

function toPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`${label} deve ser um inteiro positivo.`);
  }
  return number;
}

function normalizeMode(value) {
  const mode = String(value || 'off').trim().toLowerCase();
  if (!['off', 'memory'].includes(mode)) {
    throw new TypeError('mode deve ser off ou memory.');
  }
  return mode;
}

function noOpLogger() {}

export class CalendarioDisponibilidadeCache {
  constructor({
    mode = 'off',
    ttlMs = 15_000,
    maxEntries = 500,
    now = () => Date.now(),
    logger = noOpLogger,
  } = {}) {
    this.mode = normalizeMode(mode);
    this.ttlMs = toPositiveInteger(ttlMs, 'ttlMs');
    this.maxEntries = toPositiveInteger(maxEntries, 'maxEntries');
    this.now = now;
    this.logger = typeof logger === 'function' ? logger : noOpLogger;
    this.entries = new Map();
    this.inFlight = new Map();
    this.revisions = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      joins: 0,
      loads: 0,
      errors: 0,
      invalidations: 0,
      evictions: 0,
    };
  }

  buildKey(fisioterapeutaId, ano, mes) {
    const id = toPositiveInteger(fisioterapeutaId, 'fisioterapeutaId');
    const year = toPositiveInteger(ano, 'ano');
    const month = toPositiveInteger(mes, 'mes');
    if (month > 12) throw new TypeError('mes deve estar entre 1 e 12.');
    return `${id}:${year}-${String(month).padStart(2, '0')}`;
  }

  getRevision(fisioterapeutaId) {
    return this.revisions.get(Number(fisioterapeutaId)) || 0;
  }

  pruneExpired(nowMs) {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt <= nowMs) this.entries.delete(key);
    }
  }

  evictIfNecessary() {
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) return;
      this.entries.delete(oldestKey);
      this.stats.evictions += 1;
    }
  }

  maybeLogStats() {
    const operations = this.stats.hits + this.stats.misses + this.stats.joins;
    if (operations === 0 || operations % 100 !== 0) return;
    this.logger('info', 'Cache do calendario publico: resumo de operacoes.', {
      ...this.snapshot(),
    });
  }

  async getOrLoad({ fisioterapeutaId, ano, mes, loader }) {
    if (typeof loader !== 'function') throw new TypeError('loader deve ser uma funcao.');
    if (this.mode !== 'memory') return loader();

    const id = toPositiveInteger(fisioterapeutaId, 'fisioterapeutaId');
    const key = this.buildKey(id, ano, mes);
    const nowMs = this.now();
    this.pruneExpired(nowMs);

    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > nowMs) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      this.stats.hits += 1;
      this.maybeLogStats();
      return cached.value;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.stats.joins += 1;
      this.maybeLogStats();
      return pending;
    }

    this.stats.misses += 1;
    const revisionAtStart = this.getRevision(id);

    const loadPromise = Promise.resolve()
      .then(() => {
        this.stats.loads += 1;
        return loader();
      })
      .then((value) => {
        if (this.getRevision(id) === revisionAtStart) {
          this.evictIfNecessary();
          this.entries.set(key, {
            value,
            expiresAt: this.now() + this.ttlMs,
          });
        }
        return value;
      })
      .catch((error) => {
        this.stats.errors += 1;
        throw error;
      })
      .finally(() => {
        if (this.inFlight.get(key) === loadPromise) {
          this.inFlight.delete(key);
        }
        this.maybeLogStats();
      });

    this.inFlight.set(key, loadPromise);
    return loadPromise;
  }

  invalidateFisioterapeuta(fisioterapeutaId, reason = 'mutation') {
    const id = toPositiveInteger(fisioterapeutaId, 'fisioterapeutaId');
    const prefix = `${id}:`;
    let removed = 0;

    for (const key of this.entries.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      removed += 1;
    }

    for (const key of this.inFlight.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.inFlight.delete(key);
    }

    this.revisions.set(id, this.getRevision(id) + 1);
    this.stats.invalidations += 1;
    this.logger('debug', 'Cache do calendario publico invalidado.', {
      fisioterapeutaId: id,
      reason: String(reason || 'mutation'),
      removed,
    });
    return removed;
  }

  snapshot() {
    return {
      mode: this.mode,
      entries: this.entries.size,
      inFlight: this.inFlight.size,
      ...this.stats,
    };
  }

  clear() {
    this.entries.clear();
    this.inFlight.clear();
    this.revisions.clear();
    for (const key of Object.keys(this.stats)) this.stats[key] = 0;
  }
}

export const calendarioDisponibilidadeCache = new CalendarioDisponibilidadeCache({
  mode: ENV.CALENDARIO_PUBLICO_CACHE_MODE,
  ttlMs: ENV.CALENDARIO_PUBLICO_CACHE_TTL_MS,
  maxEntries: ENV.CALENDARIO_PUBLICO_CACHE_MAX_ENTRIES,
  logger: log,
});

export function invalidarCalendarioFisioterapeuta(fisioterapeutaId, reason) {
  return calendarioDisponibilidadeCache.invalidateFisioterapeuta(fisioterapeutaId, reason);
}
