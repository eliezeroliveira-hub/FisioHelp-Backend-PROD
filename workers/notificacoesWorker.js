import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { isProviderReal } from '../providers/pushProvider.js';
import notificacoesService from '../services/notificacoesService.js';

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
  enabled: boolEnv(process.env.NOTIF_WORKER_ENABLED, ENV.NODE_ENV !== 'production'),
  intervalMs: intEnv(process.env.NOTIF_WORKER_INTERVAL_MS, 60_000, { min: 5_000, max: 600_000 }),
  staleMinutes: intEnv(process.env.NOTIF_WORKER_STALE_MINUTES, 10, { min: 1, max: 240 }),
  batchSize: intEnv(process.env.NOTIF_WORKER_BATCH_SIZE, 10, { min: 1, max: 50 }),
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
    const disponivel = await notificacoesService.filaDisponivel(usuario);
    if (!disponivel) {
      if (!missingStructureWarned) {
        missingStructureWarned = true;
        log('warn', 'Worker de notificações aguardando estrutura V105 (FilaNotificacoes/DispositivosNotificacao).');
      }
      return;
    }
    missingStructureWarned = false;

    await notificacoesService.recuperarProcessandoTravado(
      { staleMinutes: config.staleMinutes },
      usuario
    );

    const lote = await notificacoesService.reivindicarLote(
      { batchSize: config.batchSize },
      usuario
    );

    for (const item of lote) {
      try {
        await notificacoesService.processarItem(item, usuario);
      } catch (err) {
        await notificacoesService.marcarFalhaTemporaria(
          item.Id,
          err?.message || 'Falha inesperada ao processar notificação.',
          notificacoesService.calcularBackoffSeg(item.Tentativas),
          usuario
        );

        log('warn', 'Falha ao processar notificação', {
          id: item.Id,
          tentativa: item.Tentativas,
          erro: err?.message,
        });
      }
    }
  } catch (err) {
    log('error', 'Erro no worker de notificações', { erro: err?.message });
  } finally {
    running = false;
  }
}

export function startNotificacoesWorker() {
  if (!config.enabled) {
    log('info', 'Worker de notificações desativado por NOTIF_WORKER_ENABLED=false.');
    return null;
  }

  if (ENV.NODE_ENV === 'production' && !isProviderReal) {
    log('error', 'Worker de notificações abortado: PUSH_PROVIDER_MODE=stub em produção. Defina fcm ou apns.');
    return null;
  }

  if (timer) return timer;

  timer = setInterval(() => {
    tick().catch((err) => {
      log('error', 'Erro inesperado no tick do worker de notificações', { erro: err?.message });
    });
  }, config.intervalMs);

  timer.unref?.();

  setTimeout(() => {
    tick().catch((err) => {
      log('error', 'Erro inesperado no primeiro tick do worker de notificações', { erro: err?.message });
    });
  }, 5_000).unref?.();

  log('info', 'Worker de notificações iniciado', {
    intervalMs: config.intervalMs,
    staleMinutes: config.staleMinutes,
    batchSize: config.batchSize,
    providerReal: isProviderReal,
  });

  return timer;
}

export function stopNotificacoesWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export default {
  tick,
  startNotificacoesWorker,
  stopNotificacoesWorker,
};
