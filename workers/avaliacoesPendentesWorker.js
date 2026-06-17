import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from '../services/_queryWithContext.js';
import notificacoesService from '../services/notificacoesService.js';

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

function primeiroNome(value, fallback) {
  return String(value || fallback || '').trim().split(/\s+/)[0] || fallback;
}

const config = {
  enabled: boolEnv(process.env.AVALIACAO_WORKER_ENABLED, ENV.NODE_ENV !== 'production'),
  emailEnabled: boolEnv(process.env.AVALIACAO_WORKER_EMAIL_ENABLED, true),
  intervalMs: intEnv(process.env.AVALIACAO_WORKER_INTERVAL_MS, 10 * 60 * 1000, { min: 60_000, max: 3_600_000 }),
  delayMinutes: intEnv(process.env.AVALIACAO_WORKER_DELAY_MINUTES, 30, { min: 1, max: 7 * 24 * 60 }),
  lookbackDays: intEnv(process.env.AVALIACAO_WORKER_LOOKBACK_DAYS, 7, { min: 1, max: 30 }),
  batchSize: intEnv(process.env.AVALIACAO_WORKER_BATCH_SIZE, 20, { min: 1, max: 100 }),
};

let timer = null;
let running = false;

function usuarioSistema() {
  return { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
}

async function buscarPendencias(usuario) {
  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('BatchSize', sql.Int, config.batchSize);
      req.input('DelayMinutes', sql.Int, config.delayMinutes);
      req.input('LookbackDays', sql.Int, config.lookbackDays);
      req.input('EmailEnabled', sql.Bit, config.emailEnabled ? 1 : 0);
    },
    `
      ;WITH ultimas AS (
        SELECT
          c.Id AS ConsultaId,
          c.PacienteId,
          c.FisioterapeutaId,
          c.DataHora,
          c.DataEncerramento,
          p.Nome AS PacienteNome,
          f.Nome AS FisioterapeutaNome,
          ROW_NUMBER() OVER (
            PARTITION BY c.PacienteId, c.FisioterapeutaId
            ORDER BY c.DataHora DESC, c.Id DESC
          ) AS rn
        FROM dbo.Consultas c
        INNER JOIN dbo.Pacientes p ON p.Id = c.PacienteId
        INNER JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
        WHERE LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Concluída'
      ),
      elegiveis AS (
        SELECT *
        FROM ultimas
        WHERE rn = 1
          AND DataEncerramento IS NOT NULL
          AND DATEDIFF(MINUTE, DataEncerramento, SYSDATETIME()) >= @DelayMinutes
          AND DataEncerramento >= DATEADD(DAY, -@LookbackDays, SYSDATETIME())
      )
      SELECT TOP (@BatchSize)
        pendencias.UsuarioTipo,
        pendencias.UsuarioId,
        pendencias.ConsultaId,
        pendencias.PacienteId,
        pendencias.FisioterapeutaId,
        pendencias.PacienteNome,
        pendencias.FisioterapeutaNome,
        pendencias.DataHora,
        pendencias.DataEncerramento,
        pendencias.DestinatarioPapel,
        pendencias.PrecisaPush,
        pendencias.PrecisaEmail
      FROM (
        SELECT
          N'Paciente' AS UsuarioTipo,
          e.PacienteId AS UsuarioId,
          e.ConsultaId,
          e.PacienteId,
          e.FisioterapeutaId,
          e.PacienteNome,
          e.FisioterapeutaNome,
          e.DataHora,
          e.DataEncerramento,
          N'Paciente' AS DestinatarioPapel,
          CASE WHEN NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Paciente'
              AND fn.UsuarioId = e.PacienteId
              AND fn.Canal = N'push'
              AND fn.Tipo = N'Agendamento'
              AND fn.ReferenciaId = e.ConsultaId
              AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'avaliacao_pendente'
          ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS PrecisaPush,
          CASE WHEN @EmailEnabled = 1 AND NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Paciente'
              AND fn.UsuarioId = e.PacienteId
              AND fn.Canal = N'email'
              AND fn.Tipo = N'Agendamento'
              AND fn.ReferenciaId = e.ConsultaId
              AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'avaliacao_pendente'
          ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS PrecisaEmail
        FROM elegiveis e
        WHERE NOT EXISTS (
            SELECT 1
            FROM dbo.AvaliacoesFisioterapeutas af
            WHERE af.ConsultaId = e.ConsultaId
              AND af.PacienteId = e.PacienteId
              AND af.FisioterapeutaId = e.FisioterapeutaId
          )

        UNION ALL

        SELECT
          N'Fisioterapeuta' AS UsuarioTipo,
          e.FisioterapeutaId AS UsuarioId,
          e.ConsultaId,
          e.PacienteId,
          e.FisioterapeutaId,
          e.PacienteNome,
          e.FisioterapeutaNome,
          e.DataHora,
          e.DataEncerramento,
          N'Fisioterapeuta' AS DestinatarioPapel,
          CASE WHEN NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Fisioterapeuta'
              AND fn.UsuarioId = e.FisioterapeutaId
              AND fn.Canal = N'push'
              AND fn.Tipo = N'Agendamento'
              AND fn.ReferenciaId = e.ConsultaId
              AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'avaliacao_pendente'
          ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS PrecisaPush,
          CASE WHEN @EmailEnabled = 1 AND NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Fisioterapeuta'
              AND fn.UsuarioId = e.FisioterapeutaId
              AND fn.Canal = N'email'
              AND fn.Tipo = N'Agendamento'
              AND fn.ReferenciaId = e.ConsultaId
              AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'avaliacao_pendente'
          ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS PrecisaEmail
        FROM elegiveis e
        WHERE NOT EXISTS (
            SELECT 1
            FROM dbo.Avaliacoes a
            WHERE a.ConsultaId = e.ConsultaId
              AND a.PacienteId = e.PacienteId
              AND a.FisioterapeutaId = e.FisioterapeutaId
          )
      ) pendencias
      WHERE pendencias.PrecisaPush = 1 OR pendencias.PrecisaEmail = 1
      ORDER BY pendencias.DataEncerramento ASC, pendencias.ConsultaId ASC, pendencias.UsuarioTipo ASC;
    `,
    { requireContext: true }
  );

  return result.recordset || [];
}

function montarNotificacao(row, canal = 'push') {
  const consultaId = Number(row.ConsultaId);
  const pacienteId = Number(row.PacienteId);
  const fisioterapeutaId = Number(row.FisioterapeutaId);
  const destinatarioPapel = String(row.DestinatarioPapel || row.UsuarioTipo);
  const nomePaciente = primeiroNome(row.PacienteNome, 'o paciente');
  const nomeFisioterapeuta = primeiroNome(row.FisioterapeutaNome, 'o fisioterapeuta');
  const nomePacienteCompleto = String(row.PacienteNome || '').trim() || 'o paciente';
  const nomeFisioterapeutaCompleto = String(row.FisioterapeutaNome || '').trim() || 'o fisioterapeuta';
  const dados = {
    tipo: 'avaliacao_pendente',
    consultaId,
    pacienteId,
    fisioterapeutaId,
    destinatarioPapel,
    origem: 'avaliacoesPendentesWorker',
  };

  if (destinatarioPapel === 'Paciente') {
    if (canal === 'email') {
      return {
        tipo: 'Agendamento',
        titulo: `Avalie sua experiência com ${nomeFisioterapeutaCompleto}`,
        mensagem: `Como foi sua experiência com ${nomeFisioterapeutaCompleto}? Sua avaliação ajuda outros pacientes a escolherem fisioterapeutas com mais confiança na FisioHelp. Para avaliar, acesse o app FisioHelp, toque em Consultas, abra a consulta concluída e toque em Avalie ${nomeFisioterapeutaCompleto}.`,
        referenciaId: consultaId,
        dados,
      };
    }

    return {
      tipo: 'Agendamento',
      titulo: 'Avalie sua consulta',
      mensagem: `Como foi sua consulta com ${nomeFisioterapeuta}? Sua avaliação ajuda outros pacientes na FisioHelp.`,
      referenciaId: consultaId,
      dados,
    };
  }

  if (canal === 'email') {
    return {
      tipo: 'Agendamento',
      titulo: `Avalie sua experiência com ${nomePacienteCompleto}`,
      mensagem: `Como foi sua experiência com ${nomePacienteCompleto}? Sua avaliação ajuda a manter os atendimentos mais seguros, transparentes e organizados na FisioHelp. Para avaliar, acesse o app FisioHelp, toque em Consultas, abra a consulta concluída e toque em Avalie ${nomePacienteCompleto}.`,
      referenciaId: consultaId,
      dados,
    };
  }

  return {
    tipo: 'Agendamento',
    titulo: 'Avalie o paciente',
    mensagem: `Como foi o atendimento com ${nomePaciente}? Registre sua avaliação para manter o histórico atualizado.`,
    referenciaId: consultaId,
    dados,
  };
}

async function enfileirarCanal(pendencia, canal) {
  const gravarInbox = canal !== 'email';
  await notificacoesService.enfileirarNotificacao(
    {
      usuarioTipo: pendencia.UsuarioTipo,
      usuarioId: Number(pendencia.UsuarioId),
      canal,
      ...montarNotificacao(pendencia, canal),
    },
    {
      usuarioRegistro: 'Sistema:AvaliacaoPendenteWorker',
      gravarInbox,
    }
  );
}

export async function tick() {
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
          log('warn', 'Falha ao enfileirar lembrete de avaliação pendente', {
            consultaId: pendencia.ConsultaId,
            usuarioTipo: pendencia.UsuarioTipo,
            usuarioId: pendencia.UsuarioId,
            canal,
            erro: err?.message,
          });
        }
      }
    }

    if (enfileiradas > 0) {
      log('info', 'Lembretes de avaliação pendente enfileirados', {
        total: enfileiradas,
      });
    }
  } catch (err) {
    log('error', 'Erro no worker de avaliações pendentes', { erro: err?.message });
  } finally {
    running = false;
  }
}

export function startAvaliacoesPendentesWorker() {
  if (!config.enabled) {
    log('info', 'Worker de avaliações pendentes desativado por AVALIACAO_WORKER_ENABLED=false.');
    return null;
  }

  if (timer) return timer;

  timer = setInterval(() => {
    tick().catch((err) => {
      log('error', 'Erro inesperado no tick do worker de avaliações pendentes', { erro: err?.message });
    });
  }, config.intervalMs);

  timer.unref?.();

  setTimeout(() => {
    tick().catch((err) => {
      log('error', 'Erro inesperado no primeiro tick do worker de avaliações pendentes', { erro: err?.message });
    });
  }, 10_000).unref?.();

  log('info', 'Worker de avaliações pendentes iniciado', {
    intervalMs: config.intervalMs,
    delayMinutes: config.delayMinutes,
    lookbackDays: config.lookbackDays,
    batchSize: config.batchSize,
    emailEnabled: config.emailEnabled,
  });

  return timer;
}

export function stopAvaliacoesPendentesWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export default {
  tick,
  startAvaliacoesPendentesWorker,
  stopAvaliacoesPendentesWorker,
};
