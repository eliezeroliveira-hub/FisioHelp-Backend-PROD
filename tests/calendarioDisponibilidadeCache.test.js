import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_USER ||= 'test';
process.env.DB_PASS ||= 'test';
process.env.DB_SERVER ||= 'localhost';
process.env.DB_NAME ||= 'test';
process.env.JWT_SECRET ||= 'test-secret';

const { CalendarioDisponibilidadeCache } = await import(
  '../services/calendarioDisponibilidadeCache.js'
);

test('modo off executa o loader em todas as chamadas', async () => {
  const cache = new CalendarioDisponibilidadeCache({ mode: 'off' });
  let loads = 0;
  const loader = async () => ({ value: ++loads });

  const first = await cache.getOrLoad({ fisioterapeutaId: 1, ano: 2026, mes: 9, loader });
  const second = await cache.getOrLoad({ fisioterapeutaId: 1, ano: 2026, mes: 9, loader });

  assert.equal(first.value, 1);
  assert.equal(second.value, 2);
  assert.equal(loads, 2);
  assert.equal(cache.snapshot().entries, 0);
});

test('modo memory reutiliza a resposta ate o TTL expirar', async () => {
  let nowMs = 1_000;
  let loads = 0;
  const cache = new CalendarioDisponibilidadeCache({
    mode: 'memory',
    ttlMs: 100,
    now: () => nowMs,
  });
  const loader = async () => ({ value: ++loads });

  const first = await cache.getOrLoad({ fisioterapeutaId: 2, ano: 2026, mes: 9, loader });
  nowMs += 99;
  const hit = await cache.getOrLoad({ fisioterapeutaId: 2, ano: 2026, mes: 9, loader });
  nowMs += 1;
  const expired = await cache.getOrLoad({ fisioterapeutaId: 2, ano: 2026, mes: 9, loader });

  assert.equal(first.value, 1);
  assert.strictEqual(hit, first);
  assert.equal(expired.value, 2);
  assert.deepEqual(cache.snapshot(), {
    mode: 'memory',
    entries: 1,
    inFlight: 0,
    hits: 1,
    misses: 2,
    joins: 0,
    loads: 2,
    errors: 0,
    invalidations: 0,
    evictions: 0,
  });
});

test('single-flight compartilha uma unica carga simultanea', async () => {
  let resolveLoader;
  let loads = 0;
  const cache = new CalendarioDisponibilidadeCache({ mode: 'memory' });
  const loader = () => {
    loads += 1;
    return new Promise((resolve) => {
      resolveLoader = resolve;
    });
  };

  const firstPromise = cache.getOrLoad({ fisioterapeutaId: 3, ano: 2026, mes: 10, loader });
  const secondPromise = cache.getOrLoad({ fisioterapeutaId: 3, ano: 2026, mes: 10, loader });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  assert.equal(cache.snapshot().joins, 1);

  const payload = { calendar: 'ok' };
  resolveLoader(payload);

  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.strictEqual(first, payload);
  assert.strictEqual(second, payload);
});

test('erros nao sao armazenados no cache', async () => {
  let loads = 0;
  const cache = new CalendarioDisponibilidadeCache({ mode: 'memory' });
  const loader = async () => {
    loads += 1;
    if (loads === 1) throw new Error('falha controlada');
    return { ok: true };
  };

  await assert.rejects(
    cache.getOrLoad({ fisioterapeutaId: 4, ano: 2026, mes: 9, loader }),
    /falha controlada/
  );

  const recovered = await cache.getOrLoad({ fisioterapeutaId: 4, ano: 2026, mes: 9, loader });
  assert.deepEqual(recovered, { ok: true });
  assert.equal(loads, 2);
  assert.equal(cache.snapshot().errors, 1);
});

test('invalidacao durante carga inicia uma carga nova e nao armazena a resposta antiga', async () => {
  let resolveOldLoader;
  let loads = 0;
  const cache = new CalendarioDisponibilidadeCache({ mode: 'memory' });
  const oldPromise = cache.getOrLoad({
    fisioterapeutaId: 5,
    ano: 2026,
    mes: 9,
    loader: () => {
      loads += 1;
      return new Promise((resolve) => {
        resolveOldLoader = resolve;
      });
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  cache.invalidateFisioterapeuta(5, 'test');

  const freshPayload = { value: 'novo' };
  const freshPromise = cache.getOrLoad({
    fisioterapeutaId: 5,
    ano: 2026,
    mes: 9,
    loader: async () => {
      loads += 1;
      return freshPayload;
    },
  });

  resolveOldLoader({ value: 'antigo' });
  const [old, fresh] = await Promise.all([oldPromise, freshPromise]);
  const cached = await cache.getOrLoad({
    fisioterapeutaId: 5,
    ano: 2026,
    mes: 9,
    loader: async () => ({ value: 'nao-usado' }),
  });

  assert.equal(old.value, 'antigo');
  assert.strictEqual(fresh, freshPayload);
  assert.strictEqual(cached, freshPayload);
  assert.equal(loads, 2);
  assert.equal(cache.snapshot().invalidations, 1);
  assert.equal(cache.snapshot().hits, 1);
});

test('limite de entradas remove a chave menos recentemente utilizada', async () => {
  const cache = new CalendarioDisponibilidadeCache({
    mode: 'memory',
    maxEntries: 2,
  });

  await cache.getOrLoad({ fisioterapeutaId: 6, ano: 2026, mes: 9, loader: async () => 'setembro' });
  await cache.getOrLoad({ fisioterapeutaId: 6, ano: 2026, mes: 10, loader: async () => 'outubro' });
  await cache.getOrLoad({ fisioterapeutaId: 6, ano: 2026, mes: 9, loader: async () => 'nao-usado' });
  await cache.getOrLoad({ fisioterapeutaId: 6, ano: 2026, mes: 11, loader: async () => 'novembro' });

  let octoberReloaded = false;
  await cache.getOrLoad({
    fisioterapeutaId: 6,
    ano: 2026,
    mes: 10,
    loader: async () => {
      octoberReloaded = true;
      return 'outubro-novo';
    },
  });

  assert.equal(octoberReloaded, true);
  assert.equal(cache.snapshot().evictions, 2);
});
