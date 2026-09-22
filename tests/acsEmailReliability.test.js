import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aguardarPollerAcs,
  consultarOperacaoAcsExistente,
  criarOperationIdFilaNotificacao,
  executarComAbortTimeout,
} from '../utils/acsEmailReliability.js';

test('operationId ACS e deterministico por banco e linha da fila', () => {
  const first = criarOperationIdFilaNotificacao(123, 'mvpdb-prod');
  const repeated = criarOperationIdFilaNotificacao(123, 'mvpdb-prod');
  const anotherRow = criarOperationIdFilaNotificacao(124, 'mvpdb-prod');
  const anotherDatabase = criarOperationIdFilaNotificacao(123, 'mvpdb-hml');

  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first, repeated);
  assert.notEqual(first, anotherRow);
  assert.notEqual(first, anotherDatabase);
});

test('timeout libera o chamador mesmo quando o SDK ignora o AbortSignal', async () => {
  let observedSignal;
  const startedAt = Date.now();

  await assert.rejects(
    executarComAbortTimeout((signal) => {
      observedSignal = signal;
      return new Promise(() => {});
    }, {
      timeoutMs: 20,
      descricao: 'SDK bloqueado',
    }),
    (error) => error?.code === 'ACS_EMAIL_TIMEOUT' && error?.name === 'TimeoutError'
  );

  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - startedAt < 1_000);
});

test('poll individual bloqueado retorna TimedOut dentro do limite', async () => {
  let observedSignal;
  const poller = {
    isDone: () => false,
    poll: ({ abortSignal }) => {
      observedSignal = abortSignal;
      return new Promise(() => {});
    },
    getResult: () => null,
  };

  const result = await aguardarPollerAcs(poller, {
    totalTimeoutMs: 100,
    requestTimeoutMs: 20,
    intervalMs: 1,
  });

  assert.equal(result.status, 'TimedOut');
  assert.equal(result.error.code, 'ACS_EMAIL_TIMEOUT');
  assert.equal(observedSignal.aborted, true);
});

test('poll concluido recebe AbortSignal e devolve resultado do ACS', async () => {
  let done = false;
  let observedSignal;
  const expected = { status: 'Succeeded', id: 'message-123' };
  const poller = {
    isDone: () => done,
    poll: async ({ abortSignal }) => {
      observedSignal = abortSignal;
      done = true;
    },
    getResult: () => expected,
  };

  const result = await aguardarPollerAcs(poller, {
    totalTimeoutMs: 100,
    requestTimeoutMs: 50,
    intervalMs: 1,
  });

  assert.equal(observedSignal.aborted, false);
  assert.deepEqual(result, expected);
});

test('consulta de operationId inexistente autoriza nova submissao', async () => {
  const operationId = criarOperationIdFilaNotificacao(321, 'mvpdb-hml');
  const result = await consultarOperacaoAcsExistente(async () => {
    const error = new Error('Not found');
    error.statusCode = 404;
    throw error;
  }, operationId, {
    totalTimeoutMs: 100,
    requestTimeoutMs: 50,
    intervalMs: 1,
  });

  assert.deepEqual(result, { status: 'NotFound' });
});

test('consulta de operationId acompanha Running ate Succeeded sem novo POST', async () => {
  const operationId = criarOperationIdFilaNotificacao(322, 'mvpdb-hml');
  let calls = 0;
  let clock = 0;
  const expected = { status: 'Succeeded', id: 'message-existing' };

  const result = await consultarOperacaoAcsExistente(async (_id, { abortSignal }) => {
    assert.equal(abortSignal.aborted, false);
    calls += 1;
    return calls === 1 ? { status: 'Running' } : expected;
  }, operationId, {
    totalTimeoutMs: 100,
    requestTimeoutMs: 50,
    intervalMs: 1,
    now: () => clock,
    delayFn: async (ms) => { clock += ms; },
  });

  assert.equal(calls, 2);
  assert.deepEqual(result, expected);
});
