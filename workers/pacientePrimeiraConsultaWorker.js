import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from '../services/_queryWithContext.js';
import {
  PACIENTE_ATIVACAO_DADOS_TIPO,
  PACIENTE_ATIVACAO_EMAIL_MODELO,
  PacientePrimeiraConsultaCampaignError,
  carregarConfigPacientePrimeiraConsulta,
  criarContextoPacientePrimeiraConsulta,
} from '../utils/pacientePrimeiraConsultaCampaign.js';

const TITULO_EMAIL = 'Sua conta está pronta. Que tal encontrar seu fisioterapeuta?';
const MENSAGEM_EMAIL =
  'Veja como encontrar um fisioterapeuta e agendar sua primeira consulta na FisioHelp.';

let running = false;
let disabledLogged = false;

function usuarioSistema() {
  return { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
}

function safeJsonExpression(alias, path) {
  return `CASE WHEN ISJSON(${alias}.DadosJson) = 1 THEN JSON_VALUE(${alias}.DadosJson, '${path}') END`;
}

function dataInicialSql(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

async function encerrarItensInelegiveis(usuario, contexto) {
  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('HojeBrasil', sql.Date, new Date(`${contexto.hojeBrasil}T00:00:00.000Z`));
      req.input('DadosTipo', sql.NVarChar(100), PACIENTE_ATIVACAO_DADOS_TIPO);
    },
    `
      UPDATE fn
      SET
        fn.Status = N'FalhaDefinitiva',
        fn.UltimoErro = CASE
          WHEN EXISTS (
            SELECT 1 FROM dbo.Consultas c WHERE c.PacienteId = fn.UsuarioId
          ) THEN N'Paciente já possui consulta; ativação encerrada antes do envio.'
          ELSE N'Ciclo da ativação da primeira consulta expirado antes do envio.'
        END,
        fn.ProcessandoEm = NULL,
        fn.ProximaTentativaEm = NULL,
        fn.AtualizadoEm = SYSDATETIME()
      FROM dbo.FilaNotificacoes fn
      WHERE fn.UsuarioTipo = N'Paciente'
        AND fn.Status IN (N'Pendente', N'FalhaTemporaria')
        AND ${safeJsonExpression('fn', '$.tipo')} = @DadosTipo
        AND (
          EXISTS (
            SELECT 1 FROM dbo.Consultas c WHERE c.PacienteId = fn.UsuarioId
          )
          OR TRY_CONVERT(date, ${safeJsonExpression('fn', '$.expiraEm')}, 23) IS NULL
          OR TRY_CONVERT(date, ${safeJsonExpression('fn', '$.expiraEm')}, 23) < @HojeBrasil
        );

      SELECT @@ROWCOUNT AS Encerrados;
    `,
    { requireContext: true }
  );

  return Number(result.recordset?.[0]?.Encerrados ?? 0);
}

async function buscarPendencias(usuario, config, contexto) {
  const idsExcluidosJson = JSON.stringify(config.pacienteIdsExcluidos);
  const emailsExcluidosJson = JSON.stringify(config.pacienteEmailsExcluidos);
  const dominiosTesteJson = JSON.stringify(config.dominiosTeste);

  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('BatchSize', sql.Int, config.batchSize);
      req.input('AgoraBrasil', sql.DateTime2, contexto.agoraBrasil);
      req.input('DataInicial', sql.DateTime2, dataInicialSql(config.dataInicial));
      req.input('DataInicialTexto', sql.NVarChar(10), config.dataInicial);
      req.input('PacienteEmailAlvo', sql.NVarChar(320), config.pacienteEmailAlvo);
      req.input('PilotoForcarDia', sql.Int, config.pilotoForcarDia);
      req.input('IdsExcluidosJson', sql.NVarChar(sql.MAX), idsExcluidosJson);
      req.input('EmailsExcluidosJson', sql.NVarChar(sql.MAX), emailsExcluidosJson);
      req.input('DominiosTesteJson', sql.NVarChar(sql.MAX), dominiosTesteJson);
      req.input('CampanhaId', sql.NVarChar(60), config.campanhaId);
      req.input('DadosTipo', sql.NVarChar(100), PACIENTE_ATIVACAO_DADOS_TIPO);
    },
    `
      ;WITH base AS (
        SELECT
          p.Id AS PacienteId,
          p.Nome AS PacienteNome,
          p.Email AS PacienteEmail,
          CASE
            WHEN p.DataCadastro < @DataInicial THEN @DataInicial
            ELSE CONVERT(datetime2, p.DataCadastro)
          END AS DataAncora
        FROM dbo.Pacientes p
        WHERE ISNULL(p.Ativo, 0) = 1
          AND ISNULL(p.IsBloqueado, 0) = 0
          AND ISNULL(p.EmailVerificado, 0) = 1
          AND NULLIF(LTRIM(RTRIM(ISNULL(p.Email, N''))), N'') IS NOT NULL
          AND (
            @PacienteEmailAlvo IS NULL
            OR LOWER(LTRIM(RTRIM(p.Email))) = @PacienteEmailAlvo
          )
          AND NOT EXISTS (
            SELECT 1 FROM dbo.Consultas c WHERE c.PacienteId = p.Id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.Fisioterapeutas f
            WHERE LOWER(LTRIM(RTRIM(ISNULL(f.Email, N'')))) =
              LOWER(LTRIM(RTRIM(p.Email)))
          )
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.EmailSupressao es
            WHERE LOWER(LTRIM(RTRIM(es.Email))) = LOWER(LTRIM(RTRIM(p.Email)))
          )
          AND NOT EXISTS (
            SELECT 1
            FROM OPENJSON(@IdsExcluidosJson) ids
            WHERE TRY_CONVERT(int, ids.[value]) = p.Id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM OPENJSON(@EmailsExcluidosJson) emails
            WHERE LOWER(LTRIM(RTRIM(CONVERT(nvarchar(320), emails.[value])))) =
              LOWER(LTRIM(RTRIM(p.Email)))
          )
          AND (
            @PacienteEmailAlvo IS NOT NULL
            OR NOT EXISTS (
              SELECT 1
              FROM OPENJSON(@DominiosTesteJson) domains
              WHERE LOWER(LTRIM(RTRIM(p.Email))) LIKE
                N'%@' + LOWER(LTRIM(RTRIM(CONVERT(nvarchar(253), domains.[value]))))
            )
          )
      ), com_ciclo AS (
        SELECT
          b.*,
          CASE
            WHEN @PilotoForcarDia IS NOT NULL THEN @PilotoForcarDia
            WHEN @AgoraBrasil >= DATEADD(DAY, 10, b.DataAncora)
              AND @AgoraBrasil < DATEADD(DAY, 13, b.DataAncora) THEN 10
            WHEN @AgoraBrasil >= DATEADD(DAY, 4, b.DataAncora)
              AND @AgoraBrasil < DATEADD(DAY, 10, b.DataAncora) THEN 4
            WHEN @AgoraBrasil >= DATEADD(DAY, 1, b.DataAncora)
              AND @AgoraBrasil < DATEADD(DAY, 4, b.DataAncora) THEN 1
            ELSE NULL
          END AS CicloDia
        FROM base b
      ), candidatos AS (
        SELECT
          c.PacienteId,
          c.PacienteNome,
          c.PacienteEmail,
          c.CicloDia,
          CONVERT(nvarchar(33),
            CASE
              WHEN @PilotoForcarDia IS NOT NULL THEN @AgoraBrasil
              ELSE DATEADD(DAY, c.CicloDia, c.DataAncora)
            END,
            126
          ) AS DataPrevista,
          CONVERT(nvarchar(10),
            CASE
              WHEN @PilotoForcarDia IS NOT NULL THEN DATEADD(DAY, 1, @AgoraBrasil)
              WHEN c.CicloDia = 1 THEN DATEADD(DAY, 3, c.DataAncora)
              WHEN c.CicloDia = 4 THEN DATEADD(DAY, 9, c.DataAncora)
              WHEN c.CicloDia = 10 THEN DATEADD(DAY, 12, c.DataAncora)
            END,
            23
          ) AS ExpiraEm
        FROM com_ciclo c
        WHERE c.CicloDia IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.FilaNotificacoes fn
            WHERE fn.UsuarioTipo = N'Paciente'
              AND fn.UsuarioId = c.PacienteId
              AND fn.Canal = N'email'
              AND fn.Tipo = N'Promocao'
              AND fn.ReferenciaId = c.PacienteId
              AND ${safeJsonExpression('fn', '$.tipo')} = @DadosTipo
              AND ${safeJsonExpression('fn', '$.campanhaId')} = @CampanhaId
              AND ${safeJsonExpression('fn', '$.dataInicial')} = @DataInicialTexto
              AND TRY_CONVERT(int, ${safeJsonExpression('fn', '$.cicloDia')}) = c.CicloDia
          )
      )
      SELECT TOP (@BatchSize)
        PacienteId,
        PacienteNome,
        PacienteEmail,
        CicloDia,
        DataPrevista,
        ExpiraEm
      FROM candidatos
      ORDER BY PacienteId ASC;
    `,
    { requireContext: true }
  );

  return result.recordset || [];
}

async function diagnosticarAlvoPiloto(usuario, config) {
  if (!config.pacienteEmailAlvo) return null;
  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('PacienteEmailAlvo', sql.NVarChar(320), config.pacienteEmailAlvo);
    },
    `
      SELECT TOP (1)
        CAST(ISNULL(p.Ativo, 0) AS bit) AS Ativo,
        CAST(ISNULL(p.IsBloqueado, 0) AS bit) AS Bloqueado,
        CAST(ISNULL(p.EmailVerificado, 0) AS bit) AS EmailVerificado,
        CAST(CASE WHEN EXISTS (
          SELECT 1 FROM dbo.Consultas c WHERE c.PacienteId = p.Id
        ) THEN 1 ELSE 0 END AS bit) AS TemConsulta,
        CAST(CASE WHEN EXISTS (
          SELECT 1 FROM dbo.EmailSupressao es
          WHERE LOWER(LTRIM(RTRIM(es.Email))) = LOWER(LTRIM(RTRIM(p.Email)))
        ) THEN 1 ELSE 0 END AS bit) AS EmailSuprimido,
        CAST(CASE WHEN EXISTS (
          SELECT 1 FROM dbo.Fisioterapeutas f
          WHERE LOWER(LTRIM(RTRIM(ISNULL(f.Email, N'')))) =
            LOWER(LTRIM(RTRIM(p.Email)))
        ) THEN 1 ELSE 0 END AS bit) AS TambemFisioterapeuta
      FROM dbo.Pacientes p
      WHERE LOWER(LTRIM(RTRIM(p.Email))) = @PacienteEmailAlvo;
    `,
    { requireContext: true }
  );
  const row = result.recordset?.[0];
  return {
    encontrado: Boolean(row),
    ativo: Boolean(row?.Ativo),
    bloqueado: Boolean(row?.Bloqueado),
    emailVerificado: Boolean(row?.EmailVerificado),
    temConsulta: Boolean(row?.TemConsulta),
    emailSuprimido: Boolean(row?.EmailSuprimido),
    tambemFisioterapeuta: Boolean(row?.TambemFisioterapeuta),
  };
}

function montarDados(pendencia, config) {
  return {
    tipo: PACIENTE_ATIVACAO_DADOS_TIPO,
    emailModelo: PACIENTE_ATIVACAO_EMAIL_MODELO,
    campanhaId: config.campanhaId,
    dataInicial: config.dataInicial,
    canal: 'email',
    cicloDia: Number(pendencia.CicloDia),
    dataPrevista: pendencia.DataPrevista,
    expiraEm: pendencia.ExpiraEm,
    pacienteId: Number(pendencia.PacienteId),
    pacienteNome: String(pendencia.PacienteNome || '').trim(),
    fisioterapeutasUrl: config.fisioterapeutasUrl,
    videoUrl: config.videoUrl,
    videoThumbnailUrl: config.videoThumbnailUrl,
    appStoreUrl: config.appStoreUrl,
    googlePlayUrl: config.googlePlayUrl,
    origem: 'pacientePrimeiraConsultaWorker',
  };
}

async function enfileirarSeAusente(usuario, pendencia, config) {
  const pacienteId = Number(pendencia.PacienteId);
  const cicloDia = Number(pendencia.CicloDia);
  const dadosJson = JSON.stringify(montarDados(pendencia, config));
  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('PacienteId', sql.Int, pacienteId);
      req.input('Titulo', sql.NVarChar(120), TITULO_EMAIL);
      req.input('Mensagem', sql.NVarChar(500), MENSAGEM_EMAIL);
      req.input('DadosJson', sql.NVarChar(sql.MAX), dadosJson);
      req.input('CampanhaId', sql.NVarChar(60), config.campanhaId);
      req.input('DataInicial', sql.NVarChar(10), config.dataInicial);
      req.input('CicloDia', sql.Int, cicloDia);
      req.input('DadosTipo', sql.NVarChar(100), PACIENTE_ATIVACAO_DADOS_TIPO);
      req.input(
        'UsuarioRegistro',
        sql.NVarChar(200),
        'Sistema:PacientePrimeiraConsultaWorker'
      );
    },
    `
      SET XACT_ABORT ON;
      DECLARE @LockResult int;
      DECLARE @LockResource nvarchar(255) = CONCAT(
        N'paciente-ativacao:', @CampanhaId, N':', @DataInicial, N':', @CicloDia, N':', @PacienteId
      );
      DECLARE @FilaId int = NULL;
      DECLARE @Inserido bit = 0;

      BEGIN TRY
        BEGIN TRANSACTION;
        EXEC @LockResult = sys.sp_getapplock
          @Resource = @LockResource,
          @LockMode = N'Exclusive',
          @LockOwner = N'Transaction',
          @LockTimeout = 10000;

        IF @LockResult < 0
          THROW 51000, 'Não foi possível obter o lock da ativação do paciente.', 1;

        SELECT TOP (1) @FilaId = fn.Id
        FROM dbo.FilaNotificacoes fn WITH (UPDLOCK, HOLDLOCK)
        WHERE fn.UsuarioTipo = N'Paciente'
          AND fn.UsuarioId = @PacienteId
          AND fn.Canal = N'email'
          AND fn.Tipo = N'Promocao'
          AND fn.ReferenciaId = @PacienteId
          AND ${safeJsonExpression('fn', '$.tipo')} = @DadosTipo
          AND ${safeJsonExpression('fn', '$.campanhaId')} = @CampanhaId
          AND ${safeJsonExpression('fn', '$.dataInicial')} = @DataInicial
          AND TRY_CONVERT(int, ${safeJsonExpression('fn', '$.cicloDia')}) = @CicloDia;

        IF @FilaId IS NULL
        BEGIN
          INSERT INTO dbo.FilaNotificacoes
            (UsuarioTipo, UsuarioId, Canal, Tipo, Titulo, Mensagem, DadosJson, ReferenciaId, UsuarioRegistro)
          VALUES
            (N'Paciente', @PacienteId, N'email', N'Promocao', @Titulo, @Mensagem, @DadosJson, @PacienteId, @UsuarioRegistro);
          SET @FilaId = CONVERT(int, SCOPE_IDENTITY());
          SET @Inserido = 1;
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
    config = carregarConfigPacientePrimeiraConsulta(process.env);
    if (!config.enabled) {
      if (!disabledLogged) {
        disabledLogged = true;
        log('info', 'Worker de ativação da primeira consulta desativado.');
      }
      return;
    }
    disabledLogged = false;
    contexto = criarContextoPacientePrimeiraConsulta(new Date());
    const usuario = usuarioSistema();

    const encerrados = await encerrarItensInelegiveis(usuario, contexto);
    if (encerrados > 0) {
      log('info', 'Itens inelegíveis da ativação de pacientes encerrados.', {
        totalEncerrados: encerrados,
        hojeBrasil: contexto.hojeBrasil,
      });
    }

    if (!config.emailEnabled) return;

    const diagnostico = await diagnosticarAlvoPiloto(usuario, config);
    if (diagnostico) {
      log('info', 'Diagnóstico seguro do alvo piloto da ativação de pacientes.', diagnostico);
    }

    let totalEnfileirado = 0;
    let totalPacientes = 0;
    let totalFalhas = 0;

    for (let batch = 0; batch < config.maxBatches; batch += 1) {
      const pendencias = await buscarPendencias(usuario, config, contexto);
      if (pendencias.length === 0) break;
      let inseridosNoLote = 0;

      for (const pendencia of pendencias) {
        totalPacientes += 1;
        try {
          const resultado = await enfileirarSeAusente(usuario, pendencia, config);
          if (resultado.inserido) {
            inseridosNoLote += 1;
            totalEnfileirado += 1;
          }
        } catch (error) {
          totalFalhas += 1;
          log('warn', 'Falha individual ao enfileirar ativação do paciente.', {
            pacienteId: pendencia.PacienteId,
            cicloDia: pendencia.CicloDia,
            campanhaId: config.campanhaId,
            erro: error?.message,
          });
        }
      }

      if (inseridosNoLote === 0 || pendencias.length < config.batchSize) break;
    }

    log('info', 'Campanha de ativação da primeira consulta processada.', {
      campanhaId: config.campanhaId,
      hojeBrasil: contexto.hojeBrasil,
      totalEnfileirado,
      totalPacientes,
      totalFalhas,
      pacienteEmailAlvoConfigurado: Boolean(config.pacienteEmailAlvo),
      pilotoForcarDia: config.pilotoForcarDia,
    });

    if (totalFalhas > 0) {
      throw new PacientePrimeiraConsultaCampaignError(
        'PACIENTE_ATIVACAO_ENQUEUE_FAILED',
        `Falha ao enfileirar ${totalFalhas} item(ns) de ativação de pacientes.`
      );
    }
  } catch (error) {
    log('error', error?.code || 'PACIENTE_ATIVACAO_ENQUEUE_FAILED', {
      campanhaId: config?.campanhaId,
      hojeBrasil: contexto?.hojeBrasil,
      erro: error?.message,
    });
    throw error;
  } finally {
    running = false;
  }
}

export default { tick };
