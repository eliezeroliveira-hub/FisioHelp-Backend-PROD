import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import contatoFilaService from '../services/contatoFilaService.js';

function intEnv(value, fallback, { min = 1, max = 60_000 } = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

const config = {
  staleMinutes: intEnv(process.env.CONTATO_TRANSACIONAL_WORKER_STALE_MINUTES, 10, { min: 1, max: 240 }),
  batchSize: intEnv(process.env.CONTATO_TRANSACIONAL_WORKER_BATCH_SIZE, 10, { min: 1, max: 50 }),
};

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
    const disponivel = await contatoFilaService.filaDisponivel(usuario);
    if (!disponivel) {
      if (!missingStructureWarned) {
        missingStructureWarned = true;
        log('warn', 'Worker de contato transacional aguardando estrutura V125 (FilaContatoTransacional).');
      }
      return;
    }
    missingStructureWarned = false;

    await contatoFilaService.recuperarProcessandoTravado(
      { staleMinutes: config.staleMinutes },
      usuario
    );

    const resumo = await contatoFilaService.processarPendentes(
      { batchSize: config.batchSize },
      usuario
    );

    if (resumo.processados > 0 || resumo.falhas > 0) {
      log('info', 'Worker de contato transacional executado', resumo);
    }
  } catch (err) {
    log('error', 'Erro no worker de contato transacional', { erro: err?.message });
  } finally {
    running = false;
  }
}
