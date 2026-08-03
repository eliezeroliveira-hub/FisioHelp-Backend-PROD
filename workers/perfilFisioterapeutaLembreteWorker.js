import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from '../services/_queryWithContext.js';
import notificacoesService from '../services/notificacoesService.js';

const TITULO = 'Seu perfil na FisioHelp está completo?';
const MENSAGEM = 'Abra o app FisioHelp e complete ou atualize as informações do seu perfil.';
const DADOS_TIPO = 'lembrete_perfil_fisioterapeuta';
const EMAIL_MODELO = 'lembrete_perfil_fisioterapeuta';
const INTERVAL_MS = 15 * 60 * 1000;

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
  enabled: boolEnv(process.env.PERFIL_LEMBRETE_WORKER_ENABLED, false),
  delayHours: intEnv(process.env.PERFIL_LEMBRETE_DELAY_HOURS, 48, {
    min: 1,
    max: 365 * 24,
  }),
  recurrenceMonths: intEnv(process.env.PERFIL_LEMBRETE_RECURRENCE_MONTHS, 3, {
    min: 1,
    max: 24,
  }),
  batchSize: intEnv(process.env.PERFIL_LEMBRETE_BATCH_SIZE, 20, {
    min: 1,
    max: 100,
  }),
};

let timer = null;
let running = false;
let disabledLogged = false;

function usuarioSistema() {
  return { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
}

async function buscarPendencias(usuario) {
  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('BatchSize', sql.Int, config.batchSize);
      req.input('DelayHours', sql.Int, config.delayHours);
      req.input('RecurrenceMonths', sql.Int, config.recurrenceMonths);
    },
    `
      DECLARE @AgoraUtc DATETIME2(7) = SYSUTCDATETIME();
      DECLARE @AgoraBrasil DATETIME2(7) =
        CAST(
          SYSUTCDATETIME() AT TIME ZONE 'UTC'
          AT TIME ZONE 'E. South America Standard Time'
          AS DATETIME2(7)
        );

      ;WITH candidatos AS (
        SELECT
          f.Id AS FisioterapeutaId,
          f.Nome AS FisioterapeutaNome,
          f.DataCadastro,
          f.Email,
          f.EmailVerificado,
          ultimoPush.UltimoCriadoEm AS UltimoPushCriadoEm,
          ultimoEmail.UltimoCriadoEm AS UltimoEmailCriadoEm
        FROM dbo.Fisioterapeutas f
        OUTER APPLY (
          SELECT MAX(fn.CriadoEm) AS UltimoCriadoEm
          FROM dbo.FilaNotificacoes fn
          WHERE fn.UsuarioTipo = N'Fisioterapeuta'
            AND fn.UsuarioId = f.Id
            AND fn.Canal = N'push'
            AND fn.Tipo = N'Credenciamento'
            AND fn.ReferenciaId = f.Id
            AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'lembrete_perfil_fisioterapeuta'
        ) ultimoPush
        OUTER APPLY (
          SELECT MAX(fn.CriadoEm) AS UltimoCriadoEm
          FROM dbo.FilaNotificacoes fn
          WHERE fn.UsuarioTipo = N'Fisioterapeuta'
            AND fn.UsuarioId = f.Id
            AND fn.Canal = N'email'
            AND fn.Tipo = N'Credenciamento'
            AND fn.ReferenciaId = f.Id
            AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'lembrete_perfil_fisioterapeuta'
        ) ultimoEmail
        WHERE ISNULL(f.Ativo, 0) = 1
          AND ISNULL(f.IsBloqueado, 0) = 0
          AND f.DataCadastro IS NOT NULL
          AND f.DataCadastro <= DATEADD(HOUR, -@DelayHours, @AgoraUtc)
      ),
      pendencias AS (
        SELECT
          c.*,
          CASE
            WHEN c.UltimoPushCriadoEm IS NULL
              OR DATEADD(MONTH, @RecurrenceMonths, c.UltimoPushCriadoEm) <= @AgoraBrasil
            THEN CAST(1 AS BIT)
            ELSE CAST(0 AS BIT)
          END AS PrecisaPush,
          CASE
            WHEN ISNULL(c.EmailVerificado, 0) = 1
              AND NULLIF(LTRIM(RTRIM(ISNULL(c.Email, N''))), N'') IS NOT NULL
              AND (
                c.UltimoEmailCriadoEm IS NULL
                OR DATEADD(MONTH, @RecurrenceMonths, c.UltimoEmailCriadoEm) <= @AgoraBrasil
              )
            THEN CAST(1 AS BIT)
            ELSE CAST(0 AS BIT)
          END AS PrecisaEmail
        FROM candidatos c
      )
      SELECT TOP (@BatchSize)
        FisioterapeutaId,
        FisioterapeutaNome,
        DataCadastro,
        PrecisaPush,
        PrecisaEmail
      FROM pendencias
      WHERE PrecisaPush = 1 OR PrecisaEmail = 1
      ORDER BY DataCadastro ASC, FisioterapeutaId ASC;
    `,
    { requireContext: true }
  );

  return result.recordset || [];
}

function montarNotificacao(row) {
  const fisioterapeutaId = Number(row.FisioterapeutaId);
  const fisioterapeutaNome = String(row.FisioterapeutaNome || '').trim() || 'fisioterapeuta';

  return {
    tipo: 'Credenciamento',
    titulo: TITULO,
    mensagem: MENSAGEM,
    referenciaId: fisioterapeutaId,
    dados: {
      tipo: DADOS_TIPO,
      emailModelo: EMAIL_MODELO,
      fisioterapeutaId,
      fisioterapeutaNome,
      origem: 'perfilFisioterapeutaLembreteWorker',
    },
  };
}

async function enfileirarCanal(pendencia, canal) {
  await notificacoesService.enfileirarNotificacao(
    {
      usuarioTipo: 'Fisioterapeuta',
      usuarioId: Number(pendencia.FisioterapeutaId),
      canal,
      ...montarNotificacao(pendencia),
    },
    {
      usuarioRegistro: 'Sistema:PerfilFisioterapeutaLembreteWorker',
      gravarInbox: canal === 'push',
    }
  );
}

export async function tick() {
  if (!config.enabled) {
    if (!disabledLogged) {
      disabledLogged = true;
      log('info', 'Worker de lembrete de perfil desativado por PERFIL_LEMBRETE_WORKER_ENABLED=false.');
    }
    return;
  }

  disabledLogged = false;
  if (running) return;
  running = true;

  const usuario = usuarioSistema();
  try {
    const pendencias = await buscarPendencias(usuario);
    let enfileiradas = 0;

    for (const pendencia of pendencias) {
      const canais = [];
      if (pendencia.PrecisaPush) canais.push('push');
      if (pendencia.PrecisaEmail) canais.push('email');

      for (const canal of canais) {
        try {
          await enfileirarCanal(pendencia, canal);
          enfileiradas += 1;
        } catch (err) {
          log('warn', 'Falha ao enfileirar lembrete de perfil do fisioterapeuta', {
            fisioterapeutaId: pendencia.FisioterapeutaId,
            canal,
            erro: err?.message,
          });
        }
      }
    }

    if (enfileiradas > 0) {
      log('info', 'Lembretes de perfil do fisioterapeuta enfileirados', {
        total: enfileiradas,
        fisioterapeutasProcessados: pendencias.length,
      });
    }
  } catch (err) {
    log('error', 'Erro no worker de lembrete de perfil do fisioterapeuta', {
      erro: err?.message,
    });
  } finally {
    running = false;
  }
}

export function startPerfilFisioterapeutaLembreteWorker() {
  if (!config.enabled) {
    log('info', 'Worker de lembrete de perfil desativado por PERFIL_LEMBRETE_WORKER_ENABLED=false.');
    return null;
  }

  if (timer) return timer;

  timer = setInterval(() => {
    tick().catch((err) => {
      log('error', 'Erro inesperado no tick do worker de lembrete de perfil', {
        erro: err?.message,
      });
    });
  }, INTERVAL_MS);

  timer.unref?.();

  setTimeout(() => {
    tick().catch((err) => {
      log('error', 'Erro inesperado no primeiro tick do worker de lembrete de perfil', {
        erro: err?.message,
      });
    });
  }, 10_000).unref?.();

  log('info', 'Worker de lembrete de perfil iniciado', {
    intervalMs: INTERVAL_MS,
    delayHours: config.delayHours,
    recurrenceMonths: config.recurrenceMonths,
    batchSize: config.batchSize,
  });

  return timer;
}

export function stopPerfilFisioterapeutaLembreteWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export default {
  tick,
  startPerfilFisioterapeutaLembreteWorker,
  stopPerfilFisioterapeutaLembreteWorker,
};