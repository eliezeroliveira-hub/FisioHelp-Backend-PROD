import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { sql } from '../config/dbConfig.js';
import { CHECKIN_ANTECEDENCIA_MIN } from '../config/consultaRules.js';
import { queryWithContext } from '../services/_queryWithContext.js';
import notificacoesService from '../services/notificacoesService.js';
import { agoraBrasilDate } from '../utils/appDateTime.js';

const DADOS_TIPO = 'orientacao_checkin_fisio';
const EMAIL_MODELO = 'orientacao_checkin_fisioterapeuta';
const INTERVAL_MS = 10 * 60 * 1000;

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

function optionalIntEnv(value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Valor inteiro inválido para filtro de consulta: ${value}`);
  }
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
  const normalized = texto(value);
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max - 3).trimEnd()}...`;
}

const config = {
  enabled: boolEnv(process.env.CHECKIN_ORIENTACAO_WORKER_ENABLED, false),
  emailEnabled: boolEnv(process.env.CHECKIN_ORIENTACAO_EMAIL_ENABLED, true),
  whatsappEnabled: boolEnv(process.env.CHECKIN_ORIENTACAO_WHATSAPP_ENABLED, true),
  minutosAntes: intEnv(process.env.CHECKIN_ORIENTACAO_MINUTOS_ANTES, 60, {
    min: CHECKIN_ANTECEDENCIA_MIN + 1,
    max: 24 * 60,
  }),
  minimoMinutosAntes: intEnv(
    process.env.CHECKIN_ORIENTACAO_MINIMO_MINUTOS_ANTES,
    50,
    { min: 1, max: 24 * 60 }
  ),
  batchSize: intEnv(process.env.CHECKIN_ORIENTACAO_BATCH_SIZE, 50, {
    min: 1,
    max: 100,
  }),
  consultaIdAlvo: optionalIntEnv(process.env.CHECKIN_ORIENTACAO_CONSULTA_ID, {
    min: 1,
    max: 2_147_483_647,
  }),
};

if (config.minimoMinutosAntes >= config.minutosAntes) {
  throw new Error('CHECKIN_ORIENTACAO_MINIMO_MINUTOS_ANTES deve ser menor que CHECKIN_ORIENTACAO_MINUTOS_ANTES.');
}

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
      req.input('MinutosAntes', sql.Int, config.minutosAntes);
      req.input('MinimoMinutosAntes', sql.Int, config.minimoMinutosAntes);
      req.input('EmailEnabled', sql.Bit, config.emailEnabled ? 1 : 0);
      req.input('WhatsAppEnabled', sql.Bit, config.whatsappEnabled ? 1 : 0);
      req.input('ConsultaIdAlvo', sql.Int, config.consultaIdAlvo);
      req.input('AgoraBrasil', sql.DateTime2(7), agoraBrasilDate());
    },
    `
      ;WITH elegiveis AS (
        SELECT
          c.Id AS ConsultaId,
          c.FisioterapeutaId,
          c.PacienteId,
          c.DataHora,
          CONVERT(varchar(19), c.DataHora, 126) AS DataHoraChave,
          CONVERT(varchar(10), c.DataHora, 103) AS DataTexto,
          LEFT(CONVERT(varchar(8), c.DataHora, 108), 5) AS HoraTexto,
          f.Nome AS FisioterapeutaNome,
          f.EmailVerificado,
          f.TelefoneVerificado,
          p.Nome AS PacienteNome
        FROM dbo.Consultas c
        INNER JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
        INNER JOIN dbo.Pacientes p ON p.Id = c.PacienteId
        WHERE LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Confirmada'
          AND ISNULL(f.Ativo, 0) = 1
          AND ISNULL(f.IsBloqueado, 0) = 0
          AND ISNULL(f.CrefitoVerificado, 0) = 1
          AND (@ConsultaIdAlvo IS NULL OR c.Id = @ConsultaIdAlvo)
          AND c.DataHora > DATEADD(MINUTE, @MinimoMinutosAntes, @AgoraBrasil)
          AND c.DataHora <= DATEADD(MINUTE, @MinutosAntes, @AgoraBrasil)
      )
      SELECT TOP (@BatchSize)
        e.*,
        CASE WHEN @EmailEnabled = 1
          AND ISNULL(e.EmailVerificado, 0) = 1
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Fisioterapeuta'
              AND fn.UsuarioId = e.FisioterapeutaId
              AND fn.Canal = N'email'
              AND fn.Tipo = N'Agendamento'
              AND fn.ReferenciaId = e.ConsultaId
              AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'orientacao_checkin_fisio'
              AND JSON_VALUE(fn.DadosJson, '$.dataHoraChave') = e.DataHoraChave
          )
        THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS PrecisaEmail,
        CASE WHEN @WhatsAppEnabled = 1
          AND ISNULL(e.TelefoneVerificado, 0) = 1
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Fisioterapeuta'
              AND fn.UsuarioId = e.FisioterapeutaId
              AND fn.Canal = N'whatsapp'
              AND fn.Tipo = N'Agendamento'
              AND fn.ReferenciaId = e.ConsultaId
              AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'orientacao_checkin_fisio'
              AND JSON_VALUE(fn.DadosJson, '$.dataHoraChave') = e.DataHoraChave
          )
        THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS PrecisaWhatsApp
      FROM elegiveis e
      WHERE (
        @EmailEnabled = 1
        AND ISNULL(e.EmailVerificado, 0) = 1
        AND NOT EXISTS (
          SELECT 1
          FROM dbo.FilaNotificacoes fn
          WHERE fn.UsuarioTipo = N'Fisioterapeuta'
            AND fn.UsuarioId = e.FisioterapeutaId
            AND fn.Canal = N'email'
            AND fn.Tipo = N'Agendamento'
            AND fn.ReferenciaId = e.ConsultaId
            AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'orientacao_checkin_fisio'
            AND JSON_VALUE(fn.DadosJson, '$.dataHoraChave') = e.DataHoraChave
        )
      ) OR (
        @WhatsAppEnabled = 1
        AND ISNULL(e.TelefoneVerificado, 0) = 1
        AND NOT EXISTS (
          SELECT 1
          FROM dbo.FilaNotificacoes fn
          WHERE fn.UsuarioTipo = N'Fisioterapeuta'
            AND fn.UsuarioId = e.FisioterapeutaId
            AND fn.Canal = N'whatsapp'
            AND fn.Tipo = N'Agendamento'
            AND fn.ReferenciaId = e.ConsultaId
            AND JSON_VALUE(fn.DadosJson, '$.tipo') = N'orientacao_checkin_fisio'
            AND JSON_VALUE(fn.DadosJson, '$.dataHoraChave') = e.DataHoraChave
        )
      )
      ORDER BY e.DataHora ASC, e.ConsultaId ASC;
    `,
    { requireContext: true }
  );

  return result.recordset || [];
}

export function montarOrientacaoCheckinFisio(row, canal) {
  const consultaId = Number(row.ConsultaId);
  const fisioterapeutaNome = texto(row.FisioterapeutaNome, 'Fisioterapeuta');
  const pacienteNome = texto(row.PacienteNome, 'Paciente');
  const data = texto(row.DataTexto, 'data informada no aplicativo');
  const hora = texto(row.HoraTexto, 'horário informado no aplicativo');
  const dadosBase = {
    tipo: DADOS_TIPO,
    consultaId,
    fisioterapeutaId: Number(row.FisioterapeutaId),
    pacienteId: Number(row.PacienteId),
    dataHoraChave: row.DataHoraChave,
    origem: 'orientacaoCheckinFisioWorker',
  };

  if (canal === 'email') {
    return {
      tipo: 'Agendamento',
      titulo: 'Orientações para o check-in da sua consulta',
      mensagem: `O check-in da consulta com ${pacienteNome}, em ${data} às ${hora}, ficará disponível ${CHECKIN_ANTECEDENCIA_MIN} minutos antes. Faça o check-in somente após chegar ao endereço do paciente.`,
      referenciaId: consultaId,
      dados: {
        ...dadosBase,
        emailModelo: EMAIL_MODELO,
        fisioterapeutaNome,
        pacienteNome,
        dataConsultaTexto: data,
        horaConsultaTexto: hora,
        checkinAntecedenciaMinutos: CHECKIN_ANTECEDENCIA_MIN,
      },
    };
  }

  return {
    tipo: 'Agendamento',
    titulo: 'Orientações para o check-in da sua consulta',
    mensagem: `O check-in da consulta com ${pacienteNome}, em ${data} às ${hora}, ficará disponível ${CHECKIN_ANTECEDENCIA_MIN} minutos antes. Faça o check-in somente após chegar ao endereço do paciente.`,
    referenciaId: consultaId,
    dados: {
      ...dadosBase,
      whatsappTemplate: {
        chave: 'checkin_fisio',
        variaveis: {
          1: primeiroNome(fisioterapeutaNome, 'Fisioterapeuta'),
          2: limitarTexto(pacienteNome),
          3: data,
          4: hora,
          5: String(CHECKIN_ANTECEDENCIA_MIN),
        },
      },
    },
  };
}

async function enfileirarCanal(pendencia, canal) {
  await notificacoesService.enfileirarNotificacao(
    {
      usuarioTipo: 'Fisioterapeuta',
      usuarioId: Number(pendencia.FisioterapeutaId),
      canal,
      ...montarOrientacaoCheckinFisio(pendencia, canal),
    },
    {
      usuarioRegistro: 'Sistema:OrientacaoCheckinFisioWorker',
      gravarInbox: false,
    }
  );
}

export async function tick() {
  if (!config.enabled) {
    if (!disabledLogged) {
      disabledLogged = true;
      log('info', 'Worker de orientação de check-in desativado por CHECKIN_ORIENTACAO_WORKER_ENABLED=false.');
    }
    return { habilitado: false, candidatas: 0, enfileiradas: 0 };
  }

  disabledLogged = false;
  if (running) return { habilitado: true, ignorado: 'execucao_em_andamento' };
  running = true;

  try {
    const pendencias = await buscarPendencias(usuarioSistema());
    let enfileiradas = 0;

    for (const pendencia of pendencias) {
      const canais = [];
      if (pendencia.PrecisaEmail) canais.push('email');
      if (pendencia.PrecisaWhatsApp) canais.push('whatsapp');

      for (const canal of canais) {
        try {
          await enfileirarCanal(pendencia, canal);
          enfileiradas += 1;
        } catch (error) {
          log('warn', 'Falha ao enfileirar orientação de check-in', {
            consultaId: Number(pendencia.ConsultaId),
            fisioterapeutaId: Number(pendencia.FisioterapeutaId),
            canal,
            erro: error?.message,
          });
        }
      }
    }

    if (enfileiradas > 0) {
      log('info', 'Orientações de check-in enfileiradas', {
        consultas: pendencias.length,
        enfileiradas,
      });
    }

    return { habilitado: true, candidatas: pendencias.length, enfileiradas };
  } catch (error) {
    log('error', 'Erro no worker de orientação de check-in', {
      erro: error?.message,
    });
    throw error;
  } finally {
    running = false;
  }
}

export function startOrientacaoCheckinFisioWorker() {
  if (!config.enabled) {
    log('info', 'Worker de orientação de check-in desativado por CHECKIN_ORIENTACAO_WORKER_ENABLED=false.');
    return null;
  }

  if (timer) return timer;
  timer = setInterval(() => {
    tick().catch((error) => {
      log('error', 'Erro inesperado no tick de orientação de check-in', {
        erro: error?.message,
      });
    });
  }, INTERVAL_MS);
  timer.unref?.();

  setTimeout(() => {
    tick().catch((error) => {
      log('error', 'Erro inesperado no primeiro tick de orientação de check-in', {
        erro: error?.message,
      });
    });
  }, 10_000).unref?.();

  log('info', 'Worker de orientação de check-in iniciado', {
    intervalMs: INTERVAL_MS,
    minutosAntes: config.minutosAntes,
    minimoMinutosAntes: config.minimoMinutosAntes,
    batchSize: config.batchSize,
    consultaIdAlvo: config.consultaIdAlvo,
    emailEnabled: config.emailEnabled,
    whatsappEnabled: config.whatsappEnabled,
  });

  return timer;
}

export function stopOrientacaoCheckinFisioWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export default {
  tick,
  montarOrientacaoCheckinFisio,
  startOrientacaoCheckinFisioWorker,
  stopOrientacaoCheckinFisioWorker,
};
