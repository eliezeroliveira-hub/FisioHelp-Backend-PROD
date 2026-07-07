import { log } from '../config/logger.js';
import { ENV } from '../config/env.js';
import repassesGatewayService from '../services/repassesGatewayService.js';

function boolEnv(value, fallback = false) {
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
  enabled: boolEnv(process.env.REPASSES_GATEWAY_WORKER_ENABLED, false),
  intervalMs: intEnv(process.env.REPASSES_GATEWAY_WORKER_INTERVAL_MS, 60_000, { min: 5_000, max: 600_000 }),
  staleMinutes: intEnv(process.env.REPASSES_GATEWAY_WORKER_STALE_MINUTES, 10, { min: 1, max: 240 }),
  maxAttempts: intEnv(process.env.REPASSES_GATEWAY_WORKER_MAX_ATTEMPTS, 8, { min: 1, max: 50 }),
  batchSize: intEnv(process.env.REPASSES_GATEWAY_WORKER_BATCH_SIZE, 3, { min: 1, max: 20 }),
  limitRepasses: intEnv(process.env.REPASSES_GATEWAY_WORKER_LIMIT_REPASSES, 50, { min: 1, max: 200 }),
  reconcileLimit: intEnv(process.env.REPASSES_GATEWAY_WORKER_RECONCILE_LIMIT, 5, { min: 1, max: 20 }),
  reconcileMinAgeMinutes: intEnv(process.env.REPASSES_GATEWAY_WORKER_RECONCILE_MIN_AGE_MINUTES, 5, { min: 1, max: 240 }),
};

let timer = null;
let running = false;
let missingStructureWarned = false;

function usuarioSistema() {
  return { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
}

export async function tick() {
  if (running) return;
  running = true;

  const usuario = usuarioSistema();
  try {
    const estruturaDisponivel = await repassesGatewayService.estruturaDisponivel(usuario);
    if (!estruturaDisponivel) {
      if (!missingStructureWarned) {
        missingStructureWarned = true;
        log('warn', 'Worker de repasses Asaas aguardando estrutura atualizada. Aplique os scripts REPASSES_GATEWAY_ASAAS_V103.sql e REPASSES_GATEWAY_TARIFAS_V106.sql.');
      }
      return;
    }
    missingStructureWarned = false;

    await repassesGatewayService.recuperarProcessandoTravado(
      { staleMinutes: config.staleMinutes },
      usuario
    );

    for (let i = 0; i < config.batchSize; i += 1) {
      const lote = await repassesGatewayService.claimProximo({
        limitRepasses: config.limitRepasses,
        maxAttempts: config.maxAttempts,
      }, usuario);

      if (!lote) break;

      try {
        await repassesGatewayService.processarLote(lote, usuario);
      } catch (err) {
        await repassesGatewayService.marcarFalha(
          lote,
          err,
          { maxAttempts: config.maxAttempts },
          usuario
        );
        log('warn', 'Falha ao processar lote de repasses Asaas', {
          loteId: lote.Id,
          fisioterapeutaId: lote.FisioterapeutaId,
          tentativa: lote.Tentativas,
          erro: err?.message,
        });
      }
    }

    await repassesGatewayService.reconciliarAguardando({
      limit: config.reconcileLimit,
      minAgeMinutes: config.reconcileMinAgeMinutes,
    }, usuario);
  } catch (err) {
    log('error', 'Erro no worker de repasses Asaas', { erro: err?.message });
  } finally {
    running = false;
  }
}

export function startRepassesGatewayWorker() {
  if (!config.enabled) {
    log('info', 'Worker de repasses Asaas desativado por REPASSES_GATEWAY_WORKER_ENABLED=false.');
    return null;
  }

  if (timer) return timer;

  timer = setInterval(() => {
    tick().catch((err) => {
      log('error', 'Erro inesperado no tick do worker de repasses', { erro: err?.message });
    });
  }, config.intervalMs);

  timer.unref?.();

  setTimeout(() => {
    tick().catch((err) => {
      log('error', 'Erro inesperado no primeiro tick do worker de repasses', { erro: err?.message });
    });
  }, 5_000).unref?.();

  log('info', 'Worker de repasses Asaas iniciado', {
    intervalMs: config.intervalMs,
    staleMinutes: config.staleMinutes,
    maxAttempts: config.maxAttempts,
    batchSize: config.batchSize,
    limitRepasses: config.limitRepasses,
  });

  return timer;
}

export function stopRepassesGatewayWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export default {
  tick,
  startRepassesGatewayWorker,
  stopRepassesGatewayWorker,
};
