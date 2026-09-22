import { createHash } from 'node:crypto';

export class AcsEmailTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
    this.code = 'ACS_EMAIL_TIMEOUT';
  }
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function criarOperationIdFilaNotificacao(filaId, namespace = 'fisiohelp') {
  const id = Number(filaId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('filaId inválido para gerar operationId do ACS.');
  }

  const escopo = String(namespace || '').trim().toLowerCase();
  if (!escopo || escopo.length > 120) {
    throw new Error('namespace invalido para gerar operationId do ACS.');
  }

  const hex = createHash('sha256')
    .update(`fisiohelp:${escopo}:fila-notificacao:${id}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
    .split('');

  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];

  return [
    hex.slice(0, 8).join(''),
    hex.slice(8, 12).join(''),
    hex.slice(12, 16).join(''),
    hex.slice(16, 20).join(''),
    hex.slice(20, 32).join(''),
  ].join('-');
}

export async function executarComAbortTimeout(executor, {
  timeoutMs,
  descricao = 'operação ACS',
} = {}) {
  if (typeof executor !== 'function') {
    throw new TypeError('executor deve ser uma função.');
  }

  const limiteMs = toPositiveInteger(timeoutMs, 30_000);
  const controller = new AbortController();
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new AcsEmailTimeoutError(`${descricao} excedeu ${limiteMs}ms.`);
      controller.abort(error);
      reject(error);
    }, limiteMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => executor(controller.signal)),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function aguardarPollerAcs(poller, {
  totalTimeoutMs = 90_000,
  requestTimeoutMs = 30_000,
  intervalMs = 5_000,
  now = () => Date.now(),
  delayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!poller || typeof poller.poll !== 'function') {
    throw new TypeError('Poller ACS inválido.');
  }

  const totalMs = toPositiveInteger(totalTimeoutMs, 90_000);
  const requisicaoMs = Math.min(toPositiveInteger(requestTimeoutMs, 30_000), totalMs);
  const intervaloMs = toPositiveInteger(intervalMs, 5_000);
  const deadline = now() + totalMs;

  while (!poller.isDone()) {
    const restanteMs = deadline - now();
    if (restanteMs <= 0) {
      return {
        status: 'TimedOut',
        error: new AcsEmailTimeoutError('Timeout total ao aguardar aceite do ACS.'),
      };
    }

    try {
      await executarComAbortTimeout(
        (abortSignal) => poller.poll({ abortSignal }),
        {
          timeoutMs: Math.min(requisicaoMs, restanteMs),
          descricao: 'Consulta de status do ACS',
        }
      );
    } catch (error) {
      if (error?.code === 'ACS_EMAIL_TIMEOUT' || error?.name === 'AbortError') {
        return { status: 'TimedOut', error };
      }
      throw error;
    }

    if (!poller.isDone()) {
      const esperaMs = Math.min(intervaloMs, Math.max(0, deadline - now()));
      if (esperaMs > 0) await delayFn(esperaMs);
    }
  }

  return poller.getResult();
}

export async function consultarOperacaoAcsExistente(consultar, operationId, {
  totalTimeoutMs = 90_000,
  requestTimeoutMs = 30_000,
  intervalMs = 5_000,
  now = () => Date.now(),
  delayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof consultar !== 'function') {
    throw new TypeError('consultar deve ser uma função.');
  }

  const operacao = String(operationId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operacao)) {
    throw new Error('operationId ACS inválido para consulta.');
  }

  const totalMs = toPositiveInteger(totalTimeoutMs, 90_000);
  const requisicaoMs = Math.min(toPositiveInteger(requestTimeoutMs, 30_000), totalMs);
  const intervaloMs = toPositiveInteger(intervalMs, 5_000);
  const deadline = now() + totalMs;

  while (true) {
    const restanteMs = deadline - now();
    if (restanteMs <= 0) {
      return {
        status: 'TimedOut',
        error: new AcsEmailTimeoutError('Timeout total ao consultar operação existente do ACS.'),
      };
    }

    let result;
    try {
      result = await executarComAbortTimeout(
        (abortSignal) => consultar(operacao, { abortSignal }),
        {
          timeoutMs: Math.min(requisicaoMs, restanteMs),
          descricao: 'Consulta de operação existente do ACS',
        }
      );
    } catch (error) {
      const statusCode = Number(error?.statusCode || error?.status || 0);
      const code = String(error?.code || error?.name || '').trim().toLowerCase();
      if (statusCode === 404 || code === 'notfound' || code === 'resourcenotfound') {
        return { status: 'NotFound' };
      }
      if (error?.code === 'ACS_EMAIL_TIMEOUT' || error?.name === 'AbortError') {
        return { status: 'TimedOut', error };
      }
      throw error;
    }

    const status = String(result?.status || '').trim();
    if (!['NotStarted', 'Running'].includes(status)) {
      return result || { status: 'Unknown' };
    }

    const esperaMs = Math.min(intervaloMs, Math.max(0, deadline - now()));
    if (esperaMs > 0) await delayFn(esperaMs);
  }
}

export default {
  AcsEmailTimeoutError,
  criarOperationIdFilaNotificacao,
  executarComAbortTimeout,
  aguardarPollerAcs,
  consultarOperacaoAcsExistente,
};
