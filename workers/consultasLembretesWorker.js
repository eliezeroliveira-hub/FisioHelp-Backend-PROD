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

function texto(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function primeiroNome(value, fallback) {
  return texto(value, fallback).split(/\s+/)[0] || fallback;
}

function limitarTexto(value, max = 60) {
  const normalized = String(value || '').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).trimEnd()}...`;
}

const config = {
  enabled: boolEnv(process.env.CONSULTA_LEMBRETE_WORKER_ENABLED, ENV.NODE_ENV !== 'production'),
  emailEnabled: boolEnv(process.env.CONSULTA_LEMBRETE_EMAIL_ENABLED, true),
  intervalMs: intEnv(process.env.CONSULTA_LEMBRETE_WORKER_INTERVAL_MS, 10 * 60 * 1000, { min: 60_000, max: 3_600_000 }),
  horasAntes: intEnv(process.env.CONSULTA_LEMBRETE_HORAS_ANTES, 24, { min: 3, max: 168 }),
  batchSize: intEnv(process.env.CONSULTA_LEMBRETE_BATCH_SIZE, 50, { min: 1, max: 100 }),
};

const MIN_HORAS_ANTES = 2;

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
      req.input('HorasAntes', sql.Int, config.horasAntes);
      req.input('MinHorasAntes', sql.Int, MIN_HORAS_ANTES);
      req.input('EmailEnabled', sql.Bit, config.emailEnabled ? 1 : 0);
    },
    `
      ;WITH elegiveis AS (
        SELECT
          c.Id AS ConsultaId,
          c.PacienteId,
          c.FisioterapeutaId,
          c.DataHora,
          CONVERT(varchar(19), c.DataHora, 126) AS DataHoraChave,
          CONVERT(varchar(10), c.DataHora, 103) AS DataTexto,
          LEFT(CONVERT(varchar(8), c.DataHora, 108), 5) AS HoraTexto,
          p.Nome AS PacienteNome,
          f.Nome AS FisioterapeutaNome
        FROM dbo.Consultas c
        INNER JOIN dbo.Pacientes p ON p.Id = c.PacienteId
        INNER JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
        WHERE LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Confirmada'
          AND c.DataHora > DATEADD(HOUR, @MinHorasAntes, SYSDATETIME())
          AND c.DataHora <= DATEADD(HOUR, @HorasAntes, SYSDATETIME())
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
        pendencias.DataHoraChave,
        pendencias.DataTexto,
        pendencias.HoraTexto,
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
          e.DataHoraChave,
          e.DataTexto,
          e.HoraTexto,
          N'Paciente' AS DestinatarioPapel,
          CASE WHEN NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Paciente'
              AND fn.UsuarioId = e.PacienteId
              AND fn.Canal = N'push'
              AND fn.Tipo = N'Agendamento'
              AND fn.ReferenciaId = e.ConsultaId
              AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'consulta_lembrete_24h'
              AND JSON_VALUE(fn.DadosJson, '$.dataHoraChave') = e.DataHoraChave
          ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS PrecisaPush,
          CASE WHEN @EmailEnabled = 1 AND NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Paciente'
              AND fn.UsuarioId = e.PacienteId
              AND fn.Canal = N'email'
              AND fn.Tipo = N'Agendamento'
              AND fn.ReferenciaId = e.ConsultaId
              AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'consulta_lembrete_24h'
              AND JSON_VALUE(fn.DadosJson, '$.dataHoraChave') = e.DataHoraChave
          ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS PrecisaEmail
        FROM elegiveis e

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
          e.DataHoraChave,
          e.DataTexto,
          e.HoraTexto,
          N'Fisioterapeuta' AS DestinatarioPapel,
          CASE WHEN NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Fisioterapeuta'
              AND fn.UsuarioId = e.FisioterapeutaId
              AND fn.Canal = N'push'
              AND fn.Tipo = N'Agendamento'
              AND fn.ReferenciaId = e.ConsultaId
              AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'consulta_lembrete_24h'
              AND JSON_VALUE(fn.DadosJson, '$.dataHoraChave') = e.DataHoraChave
          ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS PrecisaPush,
          CASE WHEN @EmailEnabled = 1 AND NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Fisioterapeuta'
              AND fn.UsuarioId = e.FisioterapeutaId
              AND fn.Canal = N'email'
              AND fn.Tipo = N'Agendamento'
              AND fn.ReferenciaId = e.ConsultaId
              AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'consulta_lembrete_24h'
              AND JSON_VALUE(fn.DadosJson, '$.dataHoraChave') = e.DataHoraChave
          ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS PrecisaEmail
        FROM elegiveis e
      ) pendencias
      WHERE pendencias.PrecisaPush = 1 OR pendencias.PrecisaEmail = 1
      ORDER BY pendencias.DataHora ASC, pendencias.ConsultaId ASC, pendencias.UsuarioTipo ASC;
    `,
    { requireContext: true }
  );

  return result.recordset || [];
}

function montarDados(row) {
  return {
    tipo: 'consulta_lembrete_24h',
    consultaId: Number(row.ConsultaId),
    pacienteId: Number(row.PacienteId),
    fisioterapeutaId: Number(row.FisioterapeutaId),
    dataHoraChave: row.DataHoraChave,
    destinatarioPapel: String(row.DestinatarioPapel || row.UsuarioTipo),
    origem: 'consultasLembretesWorker',
  };
}

function montarNotificacao(row, canal = 'push') {
  const consultaId = Number(row.ConsultaId);
  const destinatarioPapel = String(row.DestinatarioPapel || row.UsuarioTipo);
  const nomePaciente = primeiroNome(row.PacienteNome, 'o paciente');
  const nomeFisioterapeuta = primeiroNome(row.FisioterapeutaNome, 'o fisioterapeuta');
  const nomePacienteCompleto = limitarTexto(texto(row.PacienteNome, 'o paciente'));
  const nomeFisioterapeutaCompleto = limitarTexto(texto(row.FisioterapeutaNome, 'o fisioterapeuta'));
  const data = texto(row.DataTexto, 'data informada no aplicativo');
  const hora = texto(row.HoraTexto, 'horário informado no aplicativo');
  const dados = montarDados(row);

  if (destinatarioPapel === 'Paciente') {
    if (canal === 'email') {
      return {
        tipo: 'Agendamento',
        titulo: 'Lembrete da sua consulta na FisioHelp',
        mensagem: `Olá, ${nomePacienteCompleto},

Sua consulta com ${nomeFisioterapeutaCompleto} está se aproximando.

Resumo da consulta:
Profissional: ${nomeFisioterapeutaCompleto}
Data e hora: ${data} às ${hora}

Para ver os detalhes, endereço e orientações do atendimento, abra o app FisioHelp e acesse Consultas.

Atenciosamente,
Equipe FisioHelp`,
        referenciaId: consultaId,
        dados,
      };
    }

    return {
      tipo: 'Agendamento',
      titulo: 'Lembrete da sua consulta',
      mensagem: `Sua consulta com ${nomeFisioterapeuta} está se aproximando: ${data} às ${hora}.`,
      referenciaId: consultaId,
      dados,
    };
  }

  if (canal === 'email') {
    return {
      tipo: 'Agendamento',
      titulo: 'Lembrete de consulta na FisioHelp',
      mensagem: `Olá, ${nomeFisioterapeutaCompleto},

Você tem uma consulta com ${nomePacienteCompleto} se aproximando.

Resumo da consulta:
Paciente: ${nomePacienteCompleto}
Data e hora: ${data} às ${hora}

Para ver os detalhes e orientações do atendimento, abra o app FisioHelp e acesse Consultas.

Atenciosamente,
Equipe FisioHelp`,
      referenciaId: consultaId,
      dados,
    };
  }

  return {
    tipo: 'Agendamento',
    titulo: 'Lembrete de consulta',
    mensagem: `Você tem uma consulta com ${nomePaciente} se aproximando: ${data} às ${hora}.`,
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
      usuarioRegistro: 'Sistema:ConsultaLembreteWorker',
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
          log('warn', 'Falha ao enfileirar lembrete de consulta', {
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
      log('info', 'Lembretes de consulta enfileirados', {
        total: enfileiradas,
      });
    }
  } catch (err) {
    log('error', 'Erro no worker de lembretes de consulta', { erro: err?.message });
  } finally {
    running = false;
  }
}

export function startConsultasLembretesWorker() {
  if (!config.enabled) {
    log('info', 'Worker de lembretes de consulta desativado por CONSULTA_LEMBRETE_WORKER_ENABLED=false.');
    return null;
  }

  if (timer) return timer;

  timer = setInterval(() => {
    tick().catch((err) => {
      log('error', 'Erro inesperado no tick do worker de lembretes de consulta', { erro: err?.message });
    });
  }, config.intervalMs);

  timer.unref?.();

  setTimeout(() => {
    tick().catch((err) => {
      log('error', 'Erro inesperado no primeiro tick do worker de lembretes de consulta', { erro: err?.message });
    });
  }, 10_000).unref?.();

  log('info', 'Worker de lembretes de consulta iniciado', {
    intervalMs: config.intervalMs,
    horasAntes: config.horasAntes,
    minHorasAntes: MIN_HORAS_ANTES,
    batchSize: config.batchSize,
    emailEnabled: config.emailEnabled,
  });

  return timer;
}

export function stopConsultasLembretesWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export default {
  tick,
  startConsultasLembretesWorker,
  stopConsultasLembretesWorker,
};
