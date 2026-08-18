import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from '../services/_queryWithContext.js';
import {
  normalizarCompetencia,
  obterCompetenciaBrasil,
  resolverExecucaoCampanha,
} from '../utils/programaIndicacaoCompetencia.js';

const DADOS_TIPO = 'campanha_indicacao_fisioterapeuta';
const EMAIL_MODELO = 'programa_indicacao_fisioterapeuta';
const TITULO_PUSH = 'Programa de Indicação FisioHelp';
const PUSH_LANCAMENTO =
  'Indique fisioterapeutas e ganhe. Saiba mais no e-mail que enviamos à você';
const PUSH_MENSAL =
  'As faixas voltaram a zero. É hora de indicar de novo e ganhar. Saiba mais no e-mail que enviamos à você.';
const TITULO_EMAIL_LANCAMENTO =
  'Programa de Indicação FisioHelp: ganhe até R$ 40 por indicação aprovada';
const TITULO_EMAIL_MENSAL = 'As faixas recomeçaram: indique e ganhe neste mês';

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
    throw new Error(`Valor inteiro inválido para filtro de fisioterapeuta: ${value}`);
  }

  return n;
}


const config = {
  enabled: boolEnv(process.env.PROGRAMA_INDICACAO_WORKER_ENABLED, false),
  batchSize: intEnv(process.env.PROGRAMA_INDICACAO_BATCH_SIZE, 50, {
    min: 1,
    max: 100,
  }),
  maxBatches: intEnv(process.env.PROGRAMA_INDICACAO_MAX_BATCHES, 20, {
    min: 1,
    max: 100,
  }),
  fisioterapeutaIdAlvo: optionalIntEnv(
    process.env.PROGRAMA_INDICACAO_FISIOTERAPEUTA_ID,
    { min: 1, max: 2_147_483_647 }
  ),
  lancamentoCompetencia: normalizarCompetencia(
    process.env.PROGRAMA_INDICACAO_LANCAMENTO_COMPETENCIA
  ),
};

let running = false;
let disabledLogged = false;
let outsideWindowLoggedFor = null;

function usuarioSistema() {
  return { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
}


async function buscarPendencias(usuario, competencia) {
  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('BatchSize', sql.Int, config.batchSize);
      req.input('FisioterapeutaIdAlvo', sql.Int, config.fisioterapeutaIdAlvo);
      req.input('Competencia', sql.NVarChar(7), competencia);
      req.input('DadosTipo', sql.NVarChar(100), DADOS_TIPO);
    },
    `
      ;WITH candidatos AS (
        SELECT
          f.Id AS FisioterapeutaId,
          f.Nome AS FisioterapeutaNome,
          CASE WHEN NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Fisioterapeuta'
              AND fn.UsuarioId = f.Id
              AND fn.Canal = N'email'
              AND fn.Tipo = N'Promocao'
              AND fn.ReferenciaId = f.Id
              AND ISJSON(fn.DadosJson) = 1
              AND JSON_VALUE(fn.DadosJson, '$.tipo') = @DadosTipo
              AND JSON_VALUE(fn.DadosJson, '$.competencia') = @Competencia
          ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS PrecisaEmail,
          CASE WHEN EXISTS (
            SELECT 1
            FROM dbo.DispositivosNotificacao dn
            WHERE dn.UsuarioTipo = N'Fisioterapeuta'
              AND dn.UsuarioId = f.Id
              AND dn.Ativo = 1
          ) AND NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Fisioterapeuta'
              AND fn.UsuarioId = f.Id
              AND fn.Canal = N'push'
              AND fn.Tipo = N'Promocao'
              AND fn.ReferenciaId = f.Id
              AND ISJSON(fn.DadosJson) = 1
              AND JSON_VALUE(fn.DadosJson, '$.tipo') = @DadosTipo
              AND JSON_VALUE(fn.DadosJson, '$.competencia') = @Competencia
          ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS PrecisaPush
        FROM dbo.Fisioterapeutas f
        WHERE ISNULL(f.Ativo, 0) = 1
          AND ISNULL(f.IsBloqueado, 0) = 0
          AND ISNULL(f.CrefitoVerificado, 0) = 1
          AND ISNULL(f.EmailVerificado, 0) = 1
          AND NULLIF(LTRIM(RTRIM(ISNULL(f.Email, N''))), N'') IS NOT NULL
          AND (@FisioterapeutaIdAlvo IS NULL OR f.Id = @FisioterapeutaIdAlvo)
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.EmailSupressao es
            WHERE LOWER(LTRIM(RTRIM(es.Email))) = LOWER(LTRIM(RTRIM(f.Email)))
          )
      )
      SELECT TOP (@BatchSize)
        FisioterapeutaId,
        FisioterapeutaNome,
        PrecisaEmail,
        PrecisaPush
      FROM candidatos
      WHERE PrecisaEmail = 1 OR PrecisaPush = 1
      ORDER BY FisioterapeutaId ASC;
    `,
    { requireContext: true }
  );

  return result.recordset || [];
}

function montarNotificacao(pendencia, canal, contexto) {
  const fisioterapeutaId = Number(pendencia.FisioterapeutaId);
  const fisioterapeutaNome =
    String(pendencia.FisioterapeutaNome || '').trim() || 'fisioterapeuta';
  const mensal = contexto.variacao === 'mensal';

  return {
    titulo: canal === 'push'
      ? TITULO_PUSH
      : (mensal ? TITULO_EMAIL_MENSAL : TITULO_EMAIL_LANCAMENTO),
    mensagem: mensal ? PUSH_MENSAL : PUSH_LANCAMENTO,
    dados: {
      tipo: DADOS_TIPO,
      emailModelo: EMAIL_MODELO,
      competencia: contexto.competencia,
      variacao: contexto.variacao,
      fisioterapeutaId,
      fisioterapeutaNome,
      origem: 'programaIndicacaoFisioterapeutaWorker',
    },
  };
}

async function enfileirarCanalSeAusente(usuario, pendencia, canal, contexto) {
  const fisioterapeutaId = Number(pendencia.FisioterapeutaId);
  const notificacao = montarNotificacao(pendencia, canal, contexto);
  const dadosJson = JSON.stringify(notificacao.dados);

  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      req.input('Canal', sql.NVarChar(10), canal);
      req.input('Titulo', sql.NVarChar(120), notificacao.titulo);
      req.input('Mensagem', sql.NVarChar(500), notificacao.mensagem);
      req.input('DadosJson', sql.NVarChar(sql.MAX), dadosJson);
      req.input('Competencia', sql.NVarChar(7), contexto.competencia);
      req.input('DadosTipo', sql.NVarChar(100), DADOS_TIPO);
      req.input(
        'UsuarioRegistro',
        sql.NVarChar(200),
        'Sistema:ProgramaIndicacaoFisioterapeutaWorker'
      );
    },
    `
      SET XACT_ABORT ON;

      DECLARE @LockResult INT;
      DECLARE @LockResource NVARCHAR(255) = CONCAT(
        N'campanha-indicacao:',
        @Competencia,
        N':',
        @Canal,
        N':',
        @FisioterapeutaId
      );
      DECLARE @FilaId INT = NULL;
      DECLARE @Inserido BIT = 0;

      BEGIN TRY
        BEGIN TRANSACTION;

        EXEC @LockResult = sys.sp_getapplock
          @Resource = @LockResource,
          @LockMode = N'Exclusive',
          @LockOwner = N'Transaction',
          @LockTimeout = 10000;

        IF @LockResult < 0
          THROW 51000, 'Não foi possível obter o lock da campanha de indicação.', 1;

        SELECT TOP (1) @FilaId = fn.Id
        FROM dbo.FilaNotificacoes fn WITH (UPDLOCK, HOLDLOCK)
        WHERE fn.UsuarioTipo = N'Fisioterapeuta'
          AND fn.UsuarioId = @FisioterapeutaId
          AND fn.Canal = @Canal
          AND fn.Tipo = N'Promocao'
          AND fn.ReferenciaId = @FisioterapeutaId
          AND ISJSON(fn.DadosJson) = 1
          AND JSON_VALUE(fn.DadosJson, '$.tipo') = @DadosTipo
          AND JSON_VALUE(fn.DadosJson, '$.competencia') = @Competencia;

        IF @FilaId IS NULL
        BEGIN
          INSERT INTO dbo.FilaNotificacoes
            (
              UsuarioTipo,
              UsuarioId,
              Canal,
              Tipo,
              Titulo,
              Mensagem,
              DadosJson,
              ReferenciaId,
              UsuarioRegistro
            )
          VALUES
            (
              N'Fisioterapeuta',
              @FisioterapeutaId,
              @Canal,
              N'Promocao',
              @Titulo,
              @Mensagem,
              @DadosJson,
              @FisioterapeutaId,
              @UsuarioRegistro
            );

          SET @FilaId = CONVERT(INT, SCOPE_IDENTITY());
          SET @Inserido = 1;

          IF @Canal = N'push'
          BEGIN
            INSERT INTO dbo.Notificacoes
              (UsuarioTipo, UsuarioId, Tipo, Mensagem, Lida, DataEnvio, ReferenciaId)
            VALUES
              (
                N'Fisioterapeuta',
                @FisioterapeutaId,
                N'Promocao',
                LEFT(@Mensagem, 255),
                0,
                GETDATE(),
                @FisioterapeutaId
              );
          END;
        END;

        COMMIT TRANSACTION;

        SELECT @FilaId AS FilaId, @Inserido AS Inserido;
      END TRY
      BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH;
    `,
    { requireContext: true }
  );

  return {
    filaId: Number(result.recordset?.[0]?.FilaId ?? 0) || null,
    inserido: Number(result.recordset?.[0]?.Inserido ?? 0) === 1,
  };
}

export async function tick() {
  if (!config.enabled) {
    if (!disabledLogged) {
      disabledLogged = true;
      log(
        'info',
        'Worker do Programa de Indicação desativado por PROGRAMA_INDICACAO_WORKER_ENABLED=false.'
      );
    }
    return;
  }

  disabledLogged = false;
  if (running) return;
  running = true;

  const contexto = resolverExecucaoCampanha({
    lancamentoCompetencia: config.lancamentoCompetencia,
  });
  if (!contexto.executar) {
    if (outsideWindowLoggedFor !== contexto.competencia) {
      outsideWindowLoggedFor = contexto.competencia;
      log('info', 'Worker do Programa de Indicação fora da janela mensal.', {
        competencia: contexto.competencia,
        diaBrasil: contexto.diaBrasil,
      });
    }
    running = false;
    return;
  }

  outsideWindowLoggedFor = null;
  const usuario = usuarioSistema();
  let totalEnfileirado = 0;
  let totalFisioterapeutas = 0;

  try {
    for (let batch = 0; batch < config.maxBatches; batch += 1) {
      const pendencias = await buscarPendencias(usuario, contexto.competencia);
      if (pendencias.length === 0) break;

      let inseridosNoLote = 0;

      for (const pendencia of pendencias) {
        totalFisioterapeutas += 1;
        const canais = [];
        if (Number(pendencia.PrecisaEmail) === 1) canais.push('email');
        if (Number(pendencia.PrecisaPush) === 1) canais.push('push');

        for (const canal of canais) {
          try {
            const resultado = await enfileirarCanalSeAusente(
              usuario,
              pendencia,
              canal,
              contexto
            );
            if (resultado.inserido) {
              inseridosNoLote += 1;
              totalEnfileirado += 1;
            }
          } catch (err) {
            log('warn', 'Falha ao enfileirar campanha do Programa de Indicação', {
              fisioterapeutaId: pendencia.FisioterapeutaId,
              canal,
              competencia: contexto.competencia,
              erro: err?.message,
            });
          }
        }
      }

      if (inseridosNoLote === 0 || pendencias.length < config.batchSize) break;
    }

    log('info', 'Campanha do Programa de Indicação processada', {
      competencia: contexto.competencia,
      variacao: contexto.variacao,
      totalEnfileirado,
      totalFisioterapeutas,
      fisioterapeutaIdAlvo: config.fisioterapeutaIdAlvo,
    });
  } catch (err) {
    log('error', 'Erro no worker do Programa de Indicação', {
      competencia: contexto.competencia,
      erro: err?.message,
    });
    throw err;
  } finally {
    running = false;
  }
}

export default {
  tick,
  obterCompetenciaBrasil,
  resolverExecucaoCampanha,
};