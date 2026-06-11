import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import reembolsosGatewayFilaService from '../services/reembolsosGatewayFilaService.js';

function boolEnv(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'sim', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'nao', 'não', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function intEnv(value, fallback, { min = 1, max = 60_000 } = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

const config = {
  enabled: boolEnv(process.env.REFUND_WORKER_ENABLED, true),
  intervalMs: intEnv(process.env.REFUND_WORKER_INTERVAL_MS, 60_000, { min: 5_000, max: 600_000 }),
  staleMinutes: intEnv(process.env.REFUND_WORKER_STALE_MINUTES, 10, { min: 1, max: 240 }),
  maxAttempts: intEnv(process.env.REFUND_WORKER_MAX_ATTEMPTS, 8, { min: 1, max: 50 }),
  batchSize: intEnv(process.env.REFUND_WORKER_BATCH_SIZE, 5, { min: 1, max: 20 }),
  reconcileLimit: intEnv(process.env.REFUND_WORKER_RECONCILE_LIMIT, 5, { min: 1, max: 20 }),
  reconcileMinAgeMinutes: intEnv(process.env.REFUND_WORKER_RECONCILE_MIN_AGE_MINUTES, 5, { min: 1, max: 240 }),
};

let timer = null;
let running = false;
let missingTableWarned = false;

function usuarioSistema() {
  return { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
}

async function tick() {
  if (running) return;
  running = true;

  const usuario = usuarioSistema();
  try {
    const filaDisponivel = await reembolsosGatewayFilaService.filaDisponivel(usuario);
    if (!filaDisponivel) {
      if (!missingTableWarned) {
        missingTableWarned = true;
        log('warn', 'Worker de reembolsos Asaas aguardando dbo.FilaReembolsosGateway. Aplique o script SQL da fila.');
      }
      return;
    }
    missingTableWarned = false;

    await reembolsosGatewayFilaService.recuperarProcessandoTravado(
      { staleMinutes: config.staleMinutes },
      usuario
    );

    for (let i = 0; i < config.batchSize; i += 1) {
      const item = await reembolsosGatewayFilaService.claimProximo(usuario);
      if (!item) break;

      try {
        await reembolsosGatewayFilaService.processarItem(item, usuario);
      } catch (err) {
        await reembolsosGatewayFilaService.marcarErro(
          item,
          err,
          { maxAttempts: config.maxAttempts },
          usuario
        );
        log('warn', 'Falha ao processar item da fila de reembolso', {
          filaId: item.Id,
          transacaoId: item.TransacaoId,
          pacoteId: item.PacoteId,
          tentativa: item.Tentativas,
          erro: err?.message,
        });
      }
    }

    await reembolsosGatewayFilaService.reconciliarSolicitados(
      {
        limit: config.reconcileLimit,
        minAgeMinutes: config.reconcileMinAgeMinutes,
      },
      usuario
    );
  } catch (err) {
    log('error', 'Erro no worker de reembolsos Asaas', { erro: err?.message });
  } finally {
    running = false;
  }
}

export function startReembolsosGatewayWorker() {
  if (!config.enabled) {
    log('info', 'Worker de reembolsos Asaas desativado por REFUND_WORKER_ENABLED=false.');
    return null;
  }

  if (timer) return timer;

  timer = setInterval(() => {
    tick().catch((err) => {
      log('error', 'Erro inesperado no tick do worker de reembolsos', { erro: err?.message });
    });
  }, config.intervalMs);

  timer.unref?.();

  setTimeout(() => {
    tick().catch((err) => {
      log('error', 'Erro inesperado no primeiro tick do worker de reembolsos', { erro: err?.message });
    });
  }, 5_000).unref?.();

  log('info', 'Worker de reembolsos Asaas iniciado', {
    intervalMs: config.intervalMs,
    staleMinutes: config.staleMinutes,
    maxAttempts: config.maxAttempts,
    batchSize: config.batchSize,
  });

  return timer;
}

export function stopReembolsosGatewayWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export default {
  startReembolsosGatewayWorker,
  stopReembolsosGatewayWorker,
};
