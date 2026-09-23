import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from '../services/_queryWithContext.js';
import {
  JALECOS_CONFORTO_DADOS_TIPO,
  JALECOS_CONFORTO_EMAIL_MODELO,
  JalecosConfortoCampaignError,
  carregarConfigBeneficioJalecosConforto,
  resolverCiclosBeneficioJalecosConforto,
  verificarLinksBeneficioJalecosConforto,
} from '../utils/beneficioJalecosConfortoCampaign.js';

const TITULO_PUSH_LANCAMENTO = '10% OFF na Jalecos Conforto';
const TITULO_PUSH_LEMBRETE = 'Seu benefício continua disponível';
const PUSH_LANCAMENTO =
  'Novo benefício FisioHelp: use o cupom FisioHelp e ganhe 10% em jalecos e scrubs. Confira os detalhes no seu e-mail.';
const PUSH_LEMBRETE =
  'Use o cupom FisioHelp e aproveite 10% OFF na Jalecos Conforto. Confira como usar no e-mail da FisioHelp.';
const TITULO_EMAIL_LANCAMENTO = '🧡 Novo benefício FisioHelp: 10% OFF na Jalecos Conforto';
const TITULO_EMAIL_LEMBRETE = 'Seu cupom de 10% OFF na Jalecos Conforto';

let running = false;
let disabledLogged = false;
let outsideWindowLoggedFor = null;

function usuarioSistema() {
  return { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
}

function safeJsonExpression(alias, path) {
  return `CASE WHEN ISJSON(${alias}.DadosJson) = 1 THEN JSON_VALUE(${alias}.DadosJson, '${path}') END`;
}

async function encerrarItensExpirados(usuario, hojeBrasil) {
  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('HojeBrasil', sql.Date, new Date(`${hojeBrasil}T00:00:00.000Z`));
      req.input('DadosTipo', sql.NVarChar(100), JALECOS_CONFORTO_DADOS_TIPO);
    },
    `
      UPDATE fn
      SET
        fn.Status = N'FalhaDefinitiva',
        fn.UltimoErro = N'Campanha Jalecos Conforto expirada antes do envio.',
        fn.ProcessandoEm = NULL,
        fn.AtualizadoEm = SYSDATETIME()
      FROM dbo.FilaNotificacoes fn
      WHERE fn.Status IN (N'Pendente', N'FalhaTemporaria')
        AND ${safeJsonExpression('fn', '$.tipo')} = @DadosTipo
        AND (
          TRY_CONVERT(date, ${safeJsonExpression('fn', '$.expiraEm')}, 23) IS NULL
          OR TRY_CONVERT(date, ${safeJsonExpression('fn', '$.expiraEm')}, 23) < @HojeBrasil
        );

      SELECT @@ROWCOUNT AS Encerrados;
    `,
    { requireContext: true }
  );

  return Number(result.recordset?.[0]?.Encerrados ?? 0);
}

async function buscarPendencias(usuario, config, contexto) {
  const emailAtivo = config.emailEnabled && contexto.email.executar;
  const pushAtivo = config.pushEnabled && contexto.push.executar;
  if (!emailAtivo && !pushAtivo) return [];

  const excluidosJson = JSON.stringify(config.fisioterapeutaIdsExcluidos);
  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('BatchSize', sql.Int, config.batchSize);
      req.input('FisioterapeutaIdAlvo', sql.Int, config.fisioterapeutaIdAlvo);
      req.input(
        'FisioterapeutaEmailAlvo',
        sql.NVarChar(320),
        config.fisioterapeutaEmailAlvo
      );
      req.input('IdsExcluidosJson', sql.NVarChar(sql.MAX), excluidosJson);
      req.input('EmailAtivo', sql.Bit, emailAtivo);
      req.input('PushAtivo', sql.Bit, pushAtivo);
      req.input('EmailCiclo', sql.Int, contexto.email.ciclo);
      req.input('PushCiclo', sql.Int, contexto.push.ciclo);
      req.input('CampanhaId', sql.NVarChar(60), config.campanhaId);
      req.input('DataInicial', sql.NVarChar(10), config.dataInicial);
      req.input('DadosTipo', sql.NVarChar(100), JALECOS_CONFORTO_DADOS_TIPO);
    },
    `
      ;WITH candidatos AS (
        SELECT
          f.Id AS FisioterapeutaId,
          f.Nome AS FisioterapeutaNome,
          CASE WHEN @EmailAtivo = 1 AND NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Fisioterapeuta'
              AND fn.UsuarioId = f.Id
              AND fn.Canal = N'email'
              AND fn.Tipo = N'Promocao'
              AND fn.ReferenciaId = f.Id
              AND ${safeJsonExpression('fn', '$.tipo')} = @DadosTipo
              AND ${safeJsonExpression('fn', '$.campanhaId')} = @CampanhaId
              AND ${safeJsonExpression('fn', '$.dataInicial')} = @DataInicial
              AND TRY_CONVERT(int, ${safeJsonExpression('fn', '$.ciclo')}) = @EmailCiclo
          ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS PrecisaEmail,
          CASE WHEN @PushAtivo = 1
            AND EXISTS (
              SELECT 1
              FROM dbo.DispositivosNotificacao dn
              WHERE dn.UsuarioTipo = N'Fisioterapeuta'
                AND dn.UsuarioId = f.Id
                AND dn.Ativo = 1
            )
            AND EXISTS (
              SELECT 1
              FROM dbo.FilaNotificacoes fe
              WHERE fe.UsuarioTipo = N'Fisioterapeuta'
                AND fe.UsuarioId = f.Id
                AND fe.Canal = N'email'
                AND fe.Tipo = N'Promocao'
                AND fe.ReferenciaId = f.Id
                AND fe.Status = N'Enviado'
                AND ${safeJsonExpression('fe', '$.tipo')} = @DadosTipo
                AND ${safeJsonExpression('fe', '$.campanhaId')} = @CampanhaId
                AND ${safeJsonExpression('fe', '$.dataInicial')} = @DataInicial
            )
            AND NOT EXISTS (
              SELECT 1
              FROM dbo.FilaNotificacoes fn
              WHERE fn.UsuarioTipo = N'Fisioterapeuta'
                AND fn.UsuarioId = f.Id
                AND fn.Canal = N'push'
                AND fn.Tipo = N'Promocao'
                AND fn.ReferenciaId = f.Id
                AND ${safeJsonExpression('fn', '$.tipo')} = @DadosTipo
                AND ${safeJsonExpression('fn', '$.campanhaId')} = @CampanhaId
                AND ${safeJsonExpression('fn', '$.dataInicial')} = @DataInicial
                AND TRY_CONVERT(int, ${safeJsonExpression('fn', '$.ciclo')}) = @PushCiclo
            )
          THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS PrecisaPush
        FROM dbo.Fisioterapeutas f
        WHERE ISNULL(f.Ativo, 0) = 1
          AND ISNULL(f.IsBloqueado, 0) = 0
          AND ISNULL(f.CrefitoVerificado, 0) = 1
          AND ISNULL(f.EmailVerificado, 0) = 1
          AND NULLIF(LTRIM(RTRIM(ISNULL(f.Email, N''))), N'') IS NOT NULL
          AND (@FisioterapeutaIdAlvo IS NULL OR f.Id = @FisioterapeutaIdAlvo)
          AND (
            @FisioterapeutaEmailAlvo IS NULL
            OR LOWER(LTRIM(RTRIM(f.Email))) = @FisioterapeutaEmailAlvo
          )
          AND NOT EXISTS (
            SELECT 1
            FROM OPENJSON(@IdsExcluidosJson) ids
            WHERE TRY_CONVERT(int, ids.[value]) = f.Id
          )
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

async function diagnosticarAlvoPiloto(usuario, config) {
  if (!config.fisioterapeutaIdAlvo && !config.fisioterapeutaEmailAlvo) return null;

  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('FisioterapeutaIdAlvo', sql.Int, config.fisioterapeutaIdAlvo);
      req.input(
        'FisioterapeutaEmailAlvo',
        sql.NVarChar(320),
        config.fisioterapeutaEmailAlvo
      );
    },
    `
      SELECT TOP (1)
        CAST(ISNULL(f.Ativo, 0) AS bit) AS Ativo,
        CAST(ISNULL(f.IsBloqueado, 0) AS bit) AS Bloqueado,
        CAST(ISNULL(f.CrefitoVerificado, 0) AS bit) AS CrefitoVerificado,
        CAST(ISNULL(f.EmailVerificado, 0) AS bit) AS EmailVerificado,
        CAST(CASE WHEN EXISTS (
          SELECT 1
          FROM dbo.EmailSupressao es
          WHERE LOWER(LTRIM(RTRIM(es.Email))) = LOWER(LTRIM(RTRIM(f.Email)))
        ) THEN 1 ELSE 0 END AS bit) AS EmailSuprimido,
        CAST(CASE WHEN EXISTS (
          SELECT 1
          FROM dbo.DispositivosNotificacao dn
          WHERE dn.UsuarioTipo = N'Fisioterapeuta'
            AND dn.UsuarioId = f.Id
            AND dn.Ativo = 1
        ) THEN 1 ELSE 0 END AS bit) AS TemDispositivoAtivo
      FROM dbo.Fisioterapeutas f
      WHERE (@FisioterapeutaIdAlvo IS NULL OR f.Id = @FisioterapeutaIdAlvo)
        AND (
          @FisioterapeutaEmailAlvo IS NULL
          OR LOWER(LTRIM(RTRIM(f.Email))) = @FisioterapeutaEmailAlvo
        );
    `,
    { requireContext: true }
  );

  const row = result.recordset?.[0];
  const diagnostico = {
    encontrado: Boolean(row),
    ativo: Boolean(row?.Ativo),
    bloqueado: Boolean(row?.Bloqueado),
    crefitoVerificado: Boolean(row?.CrefitoVerificado),
    emailVerificado: Boolean(row?.EmailVerificado),
    emailSuprimido: Boolean(row?.EmailSuprimido),
    temDispositivoAtivo: Boolean(row?.TemDispositivoAtivo),
  };
  diagnostico.elegivelEmail = Boolean(
    diagnostico.encontrado &&
    diagnostico.ativo &&
    !diagnostico.bloqueado &&
    diagnostico.crefitoVerificado &&
    diagnostico.emailVerificado &&
    !diagnostico.emailSuprimido
  );

  return diagnostico;
}

function montarNotificacao(pendencia, canal, config, cicloContexto) {
  const fisioterapeutaId = Number(pendencia.FisioterapeutaId);
  const fisioterapeutaNome =
    String(pendencia.FisioterapeutaNome || '').trim() || 'fisioterapeuta';
  const lancamento = cicloContexto.variacao === 'lancamento';

  return {
    titulo: canal === 'push'
      ? (lancamento ? TITULO_PUSH_LANCAMENTO : TITULO_PUSH_LEMBRETE)
      : (lancamento ? TITULO_EMAIL_LANCAMENTO : TITULO_EMAIL_LEMBRETE),
    mensagem: lancamento ? PUSH_LANCAMENTO : PUSH_LEMBRETE,
    dados: {
      tipo: JALECOS_CONFORTO_DADOS_TIPO,
      emailModelo: JALECOS_CONFORTO_EMAIL_MODELO,
      campanhaId: config.campanhaId,
      dataInicial: config.dataInicial,
      dataFinal: config.dataFinal,
      canal,
      ciclo: cicloContexto.ciclo,
      variacao: cicloContexto.variacao,
      dataPrevista: cicloContexto.dataPrevista,
      expiraEm: cicloContexto.expiraEm,
      fisioterapeutaId,
      fisioterapeutaNome,
      ...(canal === 'email'
        ? {
            beneficioUrl: config.beneficioUrl,
            cupom: config.cupom,
          }
        : {}),
      origem: 'beneficioJalecosConfortoFisioterapeutaWorker',
    },
  };
}

async function enfileirarCanalSeAusente(
  usuario,
  pendencia,
  canal,
  config,
  cicloContexto
) {
  const fisioterapeutaId = Number(pendencia.FisioterapeutaId);
  const notificacao = montarNotificacao(
    pendencia,
    canal,
    config,
    cicloContexto
  );
  const dadosJson = JSON.stringify(notificacao.dados);

  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      req.input('Canal', sql.NVarChar(10), canal);
      req.input('Titulo', sql.NVarChar(120), notificacao.titulo);
      req.input('Mensagem', sql.NVarChar(500), notificacao.mensagem);
      req.input('DadosJson', sql.NVarChar(sql.MAX), dadosJson);
      req.input('CampanhaId', sql.NVarChar(60), config.campanhaId);
      req.input('DataInicial', sql.NVarChar(10), config.dataInicial);
      req.input('Ciclo', sql.Int, cicloContexto.ciclo);
      req.input('DadosTipo', sql.NVarChar(100), JALECOS_CONFORTO_DADOS_TIPO);
      req.input(
        'UsuarioRegistro',
        sql.NVarChar(200),
        'Sistema:BeneficioJalecosConfortoFisioterapeutaWorker'
      );
    },
    `
      SET XACT_ABORT ON;

      DECLARE @LockResult INT;
      DECLARE @LockResource NVARCHAR(255) = CONCAT(
        N'jalecos-conforto:',
        @CampanhaId,
        N':',
        @DataInicial,
        N':',
        @Canal,
        N':',
        @Ciclo,
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
          THROW 51000, 'Não foi possível obter o lock da campanha Jalecos Conforto.', 1;

        SELECT TOP (1) @FilaId = fn.Id
        FROM dbo.FilaNotificacoes fn WITH (UPDLOCK, HOLDLOCK)
        WHERE fn.UsuarioTipo = N'Fisioterapeuta'
          AND fn.UsuarioId = @FisioterapeutaId
          AND fn.Canal = @Canal
          AND fn.Tipo = N'Promocao'
          AND fn.ReferenciaId = @FisioterapeutaId
          AND ${safeJsonExpression('fn', '$.tipo')} = @DadosTipo
          AND ${safeJsonExpression('fn', '$.campanhaId')} = @CampanhaId
          AND ${safeJsonExpression('fn', '$.dataInicial')} = @DataInicial
          AND TRY_CONVERT(int, ${safeJsonExpression('fn', '$.ciclo')}) = @Ciclo;

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

          IF @Canal = N'push' AND @Ciclo = 0
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
  if (running) return;
  running = true;

  let config;
  let contexto;
  try {
    config = carregarConfigBeneficioJalecosConforto(process.env);
    if (!config.enabled) {
      if (!disabledLogged) {
        disabledLogged = true;
        log(
          'info',
          'Worker do benefício Jalecos Conforto desativado por JALECOS_CONFORTO_WORKER_ENABLED=false.'
        );
      }
      return;
    }
    disabledLogged = false;

    contexto = resolverCiclosBeneficioJalecosConforto(config, new Date());
    const usuario = usuarioSistema();
    const encerrados = await encerrarItensExpirados(usuario, contexto.hoje);
    if (encerrados > 0) {
      log('info', 'Itens expirados da campanha Jalecos Conforto encerrados', {
        totalEncerrados: encerrados,
        hojeBrasil: contexto.hoje,
      });
    }

    const emailAtivo = config.emailEnabled && contexto.email.executar;
    const pushAtivo = config.pushEnabled && contexto.push.executar;
    if (!emailAtivo && !pushAtivo) {
      const logKey = `${contexto.hoje}:${contexto.dentroDaCampanha}`;
      if (outsideWindowLoggedFor !== logKey) {
        outsideWindowLoggedFor = logKey;
        log('info', 'Worker do benefício Jalecos Conforto fora da janela de disparo.', {
          campanhaId: config.campanhaId,
          hojeBrasil: contexto.hoje,
          dentroDaCampanha: contexto.dentroDaCampanha,
        });
      }
      return;
    }
    outsideWindowLoggedFor = null;

    const diagnosticoAlvo = await diagnosticarAlvoPiloto(usuario, config);
    if (diagnosticoAlvo) {
      log('info', 'Diagnóstico seguro do alvo piloto Jalecos Conforto', diagnosticoAlvo);
    }

    try {
      await verificarLinksBeneficioJalecosConforto(config);
    } catch (error) {
      log('error', 'JALECOS_CONFORTO_LINK_CHECK_FAILED', {
        campanhaId: config.campanhaId,
        erro: error?.message,
      });
      throw error;
    }

    let totalEnfileirado = 0;
    let totalFisioterapeutas = 0;
    let totalFalhas = 0;

    for (let batch = 0; batch < config.maxBatches; batch += 1) {
      const pendencias = await buscarPendencias(usuario, config, contexto);
      if (pendencias.length === 0) break;

      let inseridosNoLote = 0;
      for (const pendencia of pendencias) {
        totalFisioterapeutas += 1;
        const canais = [];
        if (Number(pendencia.PrecisaEmail) === 1) {
          canais.push({ canal: 'email', ciclo: contexto.email });
        }
        if (Number(pendencia.PrecisaPush) === 1) {
          canais.push({ canal: 'push', ciclo: contexto.push });
        }

        for (const item of canais) {
          try {
            const resultado = await enfileirarCanalSeAusente(
              usuario,
              pendencia,
              item.canal,
              config,
              item.ciclo
            );
            if (resultado.inserido) {
              inseridosNoLote += 1;
              totalEnfileirado += 1;
            }
          } catch (error) {
            totalFalhas += 1;
            log('warn', 'Falha individual ao enfileirar benefício Jalecos Conforto', {
              fisioterapeutaId: pendencia.FisioterapeutaId,
              canal: item.canal,
              campanhaId: config.campanhaId,
              erro: error?.message,
            });
          }
        }
      }

      if (inseridosNoLote === 0 || pendencias.length < config.batchSize) break;
    }

    log('info', 'Campanha do benefício Jalecos Conforto processada', {
      campanhaId: config.campanhaId,
      hojeBrasil: contexto.hoje,
      emailCiclo: emailAtivo ? contexto.email.ciclo : null,
      pushCiclo: pushAtivo ? contexto.push.ciclo : null,
      totalEnfileirado,
      totalFisioterapeutas,
      totalFalhas,
      fisioterapeutaIdAlvo: config.fisioterapeutaIdAlvo,
      fisioterapeutaEmailAlvoConfigurado: Boolean(config.fisioterapeutaEmailAlvo),
    });

    if (totalFalhas > 0) {
      throw new JalecosConfortoCampaignError(
        'JALECOS_CONFORTO_ENQUEUE_FAILED',
        `Falha ao enfileirar ${totalFalhas} item(ns) da campanha Jalecos Conforto.`
      );
    }
  } catch (error) {
    const code = error?.code || 'JALECOS_CONFORTO_ENQUEUE_FAILED';
    log('error', code, {
      campanhaId: config?.campanhaId,
      hojeBrasil: contexto?.hoje,
      erro: error?.message,
    });
    throw error;
  } finally {
    running = false;
  }
}

export default {
  tick,
};
