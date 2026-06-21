/*
  AZURE_TIMEZONE_DEFAULTS_V116.sql
  Ajusta defaults de data/hora de negocio para horario de Sao Paulo em SQL Server/Azure SQL.
  Mantem defaults UTC intencionais fora do escopo.
*/

SET XACT_ABORT ON;
GO

BEGIN TRY
    BEGIN TRAN;

    DECLARE @ConstraintName SYSNAME;
    DECLARE @sql NVARCHAR(MAX);

    -- cache.FisioAvaliacoesMedia.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[cache].[FisioAvaliacoesMedia]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [cache].[FisioAvaliacoesMedia] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [cache].[FisioAvaliacoesMedia]
        ADD CONSTRAINT [DF_FisioAvaliacoesMedia_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- cache.FisioConsultasResumo.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[cache].[FisioConsultasResumo]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [cache].[FisioConsultasResumo] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [cache].[FisioConsultasResumo]
        ADD CONSTRAINT [DF_FisioConsultasResumo_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- cache.FisioFinanceiroResumo.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[cache].[FisioFinanceiroResumo]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [cache].[FisioFinanceiroResumo] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [cache].[FisioFinanceiroResumo]
        ADD CONSTRAINT [DF_FisioFinanceiroResumo_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- cache.FisioPerformanceMensal.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[cache].[FisioPerformanceMensal]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [cache].[FisioPerformanceMensal] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [cache].[FisioPerformanceMensal]
        ADD CONSTRAINT [DF_FisioPerformanceMensal_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- cache.FisioPerformanceMensalResumo.DataAtualizacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[cache].[FisioPerformanceMensalResumo]')
      AND c.name = N'DataAtualizacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [cache].[FisioPerformanceMensalResumo] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [cache].[FisioPerformanceMensalResumo]
        ADD CONSTRAINT [DF_FisioPerformanceMensalResumo_DataAtualizacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataAtualizacao];

    -- cache.LogAtualizacaoCache.DataAtualizacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[cache].[LogAtualizacaoCache]')
      AND c.name = N'DataAtualizacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [cache].[LogAtualizacaoCache] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [cache].[LogAtualizacaoCache]
        ADD CONSTRAINT [DF_LogAtualizacaoCache_DataAtualizacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataAtualizacao];

    -- dbo.AccessTokenBlacklist.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[AccessTokenBlacklist]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[AccessTokenBlacklist] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[AccessTokenBlacklist]
        ADD CONSTRAINT [DF_AccessTokenBlacklist_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.AceitesDocumentosLegais.AceitoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[AceitesDocumentosLegais]')
      AND c.name = N'AceitoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[AceitesDocumentosLegais] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[AceitesDocumentosLegais]
        ADD CONSTRAINT [DF_AceitesDocumentosLegais_AceitoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AceitoEm];

    -- dbo.AgendasExcecoesDia.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[AgendasExcecoesDia]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[AgendasExcecoesDia] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[AgendasExcecoesDia]
        ADD CONSTRAINT [DF_AgendasExcecoesDia_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.AgendasFisioterapeutas.DataCriacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[AgendasFisioterapeutas]')
      AND c.name = N'DataCriacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[AgendasFisioterapeutas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[AgendasFisioterapeutas]
        ADD CONSTRAINT [DF_AgendasFisioterapeutas_DataCriacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataCriacao];

    -- dbo.AjustesRepasses.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[AjustesRepasses]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[AjustesRepasses] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[AjustesRepasses]
        ADD CONSTRAINT [DF_AjustesRepasses_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.AssinaturasPremium.DataInicio
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[AssinaturasPremium]')
      AND c.name = N'DataInicio';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[AssinaturasPremium] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[AssinaturasPremium]
        ADD CONSTRAINT [DF_AssinaturasPremium_DataInicio]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataInicio];

    -- dbo.AuditoriaTriggersLogs.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[AuditoriaTriggersLogs]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[AuditoriaTriggersLogs] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[AuditoriaTriggersLogs]
        ADD CONSTRAINT [DF_AuditoriaTriggersLogs_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.Avaliacoes.DataAvaliacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Avaliacoes]')
      AND c.name = N'DataAvaliacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Avaliacoes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Avaliacoes]
        ADD CONSTRAINT [DF_Avaliacoes_DataAvaliacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataAvaliacao];

    -- dbo.AvaliacoesFisioterapeutas.DataAvaliacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[AvaliacoesFisioterapeutas]')
      AND c.name = N'DataAvaliacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[AvaliacoesFisioterapeutas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[AvaliacoesFisioterapeutas]
        ADD CONSTRAINT [DF_AvaliacoesFisioterapeutas_DataAvaliacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataAvaliacao];

    -- dbo.CacheRankingFisioterapeutas.DataAtualizacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[CacheRankingFisioterapeutas]')
      AND c.name = N'DataAtualizacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[CacheRankingFisioterapeutas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[CacheRankingFisioterapeutas]
        ADD CONSTRAINT [DF_CacheRankingFisioterapeutas_DataAtualizacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataAtualizacao];

    -- dbo.CancelamentosLogs.CanceladoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[CancelamentosLogs]')
      AND c.name = N'CanceladoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[CancelamentosLogs] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[CancelamentosLogs]
        ADD CONSTRAINT [DF_CancelamentosLogs_CanceladoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CanceladoEm];

    -- dbo.ChatEncerramentoLogs.ExecutadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[ChatEncerramentoLogs]')
      AND c.name = N'ExecutadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[ChatEncerramentoLogs] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[ChatEncerramentoLogs]
        ADD CONSTRAINT [DF_ChatEncerramentoLogs_ExecutadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [ExecutadoEm];

    -- dbo.ChatModerationAlertLogs.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[ChatModerationAlertLogs]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[ChatModerationAlertLogs] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[ChatModerationAlertLogs]
        ADD CONSTRAINT [DF_ChatModerationAlertLogs_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.ChatModerationLogs.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[ChatModerationLogs]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[ChatModerationLogs] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[ChatModerationLogs]
        ADD CONSTRAINT [DF_ChatModerationLogs_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.ChatsAtivos.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[ChatsAtivos]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[ChatsAtivos] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[ChatsAtivos]
        ADD CONSTRAINT [DF_ChatsAtivos_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.CodigosIndicacao.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[CodigosIndicacao]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[CodigosIndicacao] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[CodigosIndicacao]
        ADD CONSTRAINT [DF_CodigosIndicacao_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.ConsultasLogs.DataHora
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[ConsultasLogs]')
      AND c.name = N'DataHora';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[ConsultasLogs] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[ConsultasLogs]
        ADD CONSTRAINT [DF_ConsultasLogs_DataHora]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataHora];

    -- dbo.CreditosPacientes.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[CreditosPacientes]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[CreditosPacientes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[CreditosPacientes]
        ADD CONSTRAINT [DF_CreditosPacientes_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.Despesas.DataCriacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Despesas]')
      AND c.name = N'DataCriacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Despesas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Despesas]
        ADD CONSTRAINT [DF_Despesas_DataCriacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataCriacao];

    -- dbo.DispositivosNotificacao.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[DispositivosNotificacao]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[DispositivosNotificacao] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[DispositivosNotificacao]
        ADD CONSTRAINT [DF_DispositivosNotificacao_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- dbo.DispositivosNotificacao.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[DispositivosNotificacao]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[DispositivosNotificacao] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[DispositivosNotificacao]
        ADD CONSTRAINT [DF_DispositivosNotificacao_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.DisputasConsultas.AbertaEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[DisputasConsultas]')
      AND c.name = N'AbertaEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[DisputasConsultas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[DisputasConsultas]
        ADD CONSTRAINT [DF_DisputasConsultas_AbertaEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AbertaEm];

    -- dbo.DocumentosFisioterapeutas.DataEnvio
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[DocumentosFisioterapeutas]')
      AND c.name = N'DataEnvio';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[DocumentosFisioterapeutas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[DocumentosFisioterapeutas]
        ADD CONSTRAINT [DF_DocumentosFisioterapeutas_DataEnvio]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataEnvio];

    -- dbo.DocumentosLegais.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[DocumentosLegais]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[DocumentosLegais] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[DocumentosLegais]
        ADD CONSTRAINT [DF_DocumentosLegais_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- dbo.DocumentosLegais.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[DocumentosLegais]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[DocumentosLegais] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[DocumentosLegais]
        ADD CONSTRAINT [DF_DocumentosLegais_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.DocumentosPacientes.DataEnvio
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[DocumentosPacientes]')
      AND c.name = N'DataEnvio';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[DocumentosPacientes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[DocumentosPacientes]
        ADD CONSTRAINT [DF_DocumentosPacientes_DataEnvio]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataEnvio];

    -- dbo.DocumentosValidacao.DataEnvio
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[DocumentosValidacao]')
      AND c.name = N'DataEnvio';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[DocumentosValidacao] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[DocumentosValidacao]
        ADD CONSTRAINT [DF_DocumentosValidacao_DataEnvio]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataEnvio];

    -- dbo.EmailSupressao.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[EmailSupressao]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[EmailSupressao] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[EmailSupressao]
        ADD CONSTRAINT [DF_EmailSupressao_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- dbo.EmailSupressao.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[EmailSupressao]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[EmailSupressao] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[EmailSupressao]
        ADD CONSTRAINT [DF_EmailSupressao_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.FaleConoscoCategorias.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FaleConoscoCategorias]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FaleConoscoCategorias] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FaleConoscoCategorias]
        ADD CONSTRAINT [DF_FaleConoscoCategorias_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.FaleConoscoChamadoAnexos.EnviadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FaleConoscoChamadoAnexos]')
      AND c.name = N'EnviadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FaleConoscoChamadoAnexos] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FaleConoscoChamadoAnexos]
        ADD CONSTRAINT [DF_FaleConoscoChamadoAnexos_EnviadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [EnviadoEm];

    -- dbo.FaleConoscoChamados.DataAbertura
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FaleConoscoChamados]')
      AND c.name = N'DataAbertura';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FaleConoscoChamados] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FaleConoscoChamados]
        ADD CONSTRAINT [DF_FaleConoscoChamados_DataAbertura]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataAbertura];

    -- dbo.FaleConoscoChamados.UltimaAtualizacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FaleConoscoChamados]')
      AND c.name = N'UltimaAtualizacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FaleConoscoChamados] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FaleConoscoChamados]
        ADD CONSTRAINT [DF_FaleConoscoChamados_UltimaAtualizacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [UltimaAtualizacao];

    -- dbo.Favoritos.DataAdicionado
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Favoritos]')
      AND c.name = N'DataAdicionado';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Favoritos] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Favoritos]
        ADD CONSTRAINT [DF_Favoritos_DataAdicionado]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataAdicionado];

    -- dbo.FilaAtualizacaoPontos.DataRegistro
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FilaAtualizacaoPontos]')
      AND c.name = N'DataRegistro';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FilaAtualizacaoPontos] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FilaAtualizacaoPontos]
        ADD CONSTRAINT [DF_FilaAtualizacaoPontos_DataRegistro]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataRegistro];

    -- dbo.FilaNotificacoes.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FilaNotificacoes]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FilaNotificacoes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FilaNotificacoes]
        ADD CONSTRAINT [DF_FilaNotificacoes_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- dbo.FilaNotificacoes.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FilaNotificacoes]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FilaNotificacoes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FilaNotificacoes]
        ADD CONSTRAINT [DF_FilaNotificacoes_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.FilaReembolsosGateway.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FilaReembolsosGateway]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FilaReembolsosGateway] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FilaReembolsosGateway]
        ADD CONSTRAINT [DF_FilaReembolsosGateway_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- dbo.FilaReembolsosGateway.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FilaReembolsosGateway]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FilaReembolsosGateway] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FilaReembolsosGateway]
        ADD CONSTRAINT [DF_FilaReembolsosGateway_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.FinanceiroDecomposicoes.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FinanceiroDecomposicoes]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FinanceiroDecomposicoes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FinanceiroDecomposicoes]
        ADD CONSTRAINT [DF_FinanceiroDecomposicoes_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.FisioPacientesCarteira.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FisioPacientesCarteira]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FisioPacientesCarteira] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FisioPacientesCarteira]
        ADD CONSTRAINT [DF_FisioPacientesCarteira_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.FisioterapeutaEspecialidades.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FisioterapeutaEspecialidades]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FisioterapeutaEspecialidades] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FisioterapeutaEspecialidades]
        ADD CONSTRAINT [DF_FisioterapeutaEspecialidades_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.Fisioterapeutas.DataCadastro
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Fisioterapeutas]')
      AND c.name = N'DataCadastro';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Fisioterapeutas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Fisioterapeutas]
        ADD CONSTRAINT [DF_Fisioterapeutas_DataCadastro]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataCadastro];

    -- dbo.FisioterapeutasMetricasPublicas.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FisioterapeutasMetricasPublicas]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FisioterapeutasMetricasPublicas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FisioterapeutasMetricasPublicas]
        ADD CONSTRAINT [DF_FisioterapeutasMetricasPublicas_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- dbo.FormacoesFisioterapeutas.DataCadastro
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[FormacoesFisioterapeutas]')
      AND c.name = N'DataCadastro';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[FormacoesFisioterapeutas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[FormacoesFisioterapeutas]
        ADD CONSTRAINT [DF_FormacoesFisioterapeutas_DataCadastro]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataCadastro];

    -- dbo.GatewayPerfisCusto.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[GatewayPerfisCusto]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[GatewayPerfisCusto] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[GatewayPerfisCusto]
        ADD CONSTRAINT [DF_GatewayPerfisCusto_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.GatewayPerfisCusto.DataInicio
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[GatewayPerfisCusto]')
      AND c.name = N'DataInicio';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[GatewayPerfisCusto] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[GatewayPerfisCusto]
        ADD CONSTRAINT [DF_GatewayPerfisCusto_DataInicio]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataInicio];

    -- dbo.HorariosBloqueados.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[HorariosBloqueados]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[HorariosBloqueados] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[HorariosBloqueados]
        ADD CONSTRAINT [DF_HorariosBloqueados_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.Indicacoes.DataIndicacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Indicacoes]')
      AND c.name = N'DataIndicacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Indicacoes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Indicacoes]
        ADD CONSTRAINT [DF_Indicacoes_DataIndicacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataIndicacao];

    -- dbo.Localizacoes.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Localizacoes]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Localizacoes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Localizacoes]
        ADD CONSTRAINT [DF_Localizacoes_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- dbo.LoginLockouts.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[LoginLockouts]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[LoginLockouts] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[LoginLockouts]
        ADD CONSTRAINT [DF_LoginLockouts_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- dbo.LoginLockouts.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[LoginLockouts]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[LoginLockouts] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[LoginLockouts]
        ADD CONSTRAINT [DF_LoginLockouts_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.LogsDocumentos.DataAcao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[LogsDocumentos]')
      AND c.name = N'DataAcao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[LogsDocumentos] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[LogsDocumentos]
        ADD CONSTRAINT [DF_LogsDocumentos_DataAcao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataAcao];

    -- dbo.LogsFinanceiros.DataAcao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[LogsFinanceiros]')
      AND c.name = N'DataAcao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[LogsFinanceiros] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[LogsFinanceiros]
        ADD CONSTRAINT [DF_LogsFinanceiros_DataAcao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataAcao];

    -- dbo.LogsJobs.DataExecucao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[LogsJobs]')
      AND c.name = N'DataExecucao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[LogsJobs] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[LogsJobs]
        ADD CONSTRAINT [DF_LogsJobs_DataExecucao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataExecucao];

    -- dbo.LogsSistema.DataRegistro
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[LogsSistema]')
      AND c.name = N'DataRegistro';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[LogsSistema] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[LogsSistema]
        ADD CONSTRAINT [DF_LogsSistema_DataRegistro]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataRegistro];

    -- dbo.LoteRepassesGatewayAjustes.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[LoteRepassesGatewayAjustes]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[LoteRepassesGatewayAjustes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[LoteRepassesGatewayAjustes]
        ADD CONSTRAINT [DF_LoteRepassesGatewayAjustes_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- dbo.LoteRepassesGatewayAjustes.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[LoteRepassesGatewayAjustes]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[LoteRepassesGatewayAjustes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[LoteRepassesGatewayAjustes]
        ADD CONSTRAINT [DF_LoteRepassesGatewayAjustes_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.LoteRepassesGatewayItens.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[LoteRepassesGatewayItens]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[LoteRepassesGatewayItens] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[LoteRepassesGatewayItens]
        ADD CONSTRAINT [DF_LoteRepassesGatewayItens_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- dbo.LoteRepassesGatewayItens.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[LoteRepassesGatewayItens]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[LoteRepassesGatewayItens] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[LoteRepassesGatewayItens]
        ADD CONSTRAINT [DF_LoteRepassesGatewayItens_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.LotesRepassesGateway.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[LotesRepassesGateway]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[LotesRepassesGateway] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[LotesRepassesGateway]
        ADD CONSTRAINT [DF_LotesRepassesGateway_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- dbo.LotesRepassesGateway.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[LotesRepassesGateway]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[LotesRepassesGateway] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[LotesRepassesGateway]
        ADD CONSTRAINT [DF_LotesRepassesGateway_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.Mensagens.DataEnvio
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Mensagens]')
      AND c.name = N'DataEnvio';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Mensagens] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Mensagens]
        ADD CONSTRAINT [DF_Mensagens_DataEnvio]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataEnvio];

    -- dbo.MetodoPagamentos.DataCriacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[MetodoPagamentos]')
      AND c.name = N'DataCriacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[MetodoPagamentos] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[MetodoPagamentos]
        ADD CONSTRAINT [DF_MetodoPagamentos_DataCriacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataCriacao];

    -- dbo.NotasFiscaisFisioterapeutas.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[NotasFiscaisFisioterapeutas]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[NotasFiscaisFisioterapeutas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[NotasFiscaisFisioterapeutas]
        ADD CONSTRAINT [DF_NotasFiscaisFisioterapeutas_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- dbo.NotasFiscaisFisioterapeutas.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[NotasFiscaisFisioterapeutas]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[NotasFiscaisFisioterapeutas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[NotasFiscaisFisioterapeutas]
        ADD CONSTRAINT [DF_NotasFiscaisFisioterapeutas_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.Notificacoes.DataEnvio
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Notificacoes]')
      AND c.name = N'DataEnvio';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Notificacoes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Notificacoes]
        ADD CONSTRAINT [DF_Notificacoes_DataEnvio]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataEnvio];

    -- dbo.Pacientes.DataCadastro
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Pacientes]')
      AND c.name = N'DataCadastro';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Pacientes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Pacientes]
        ADD CONSTRAINT [DF_Pacientes_DataCadastro]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataCadastro];

    -- dbo.Pacotes.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Pacotes]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Pacotes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Pacotes]
        ADD CONSTRAINT [DF_Pacotes_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.Pacotes.DataCompra
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Pacotes]')
      AND c.name = N'DataCompra';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Pacotes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Pacotes]
        ADD CONSTRAINT [DF_Pacotes_DataCompra]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataCompra];

    -- dbo.ParametrosAssinaturas.DataInicio
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[ParametrosAssinaturas]')
      AND c.name = N'DataInicio';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[ParametrosAssinaturas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[ParametrosAssinaturas]
        ADD CONSTRAINT [DF_ParametrosAssinaturas_DataInicio]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataInicio];

    -- dbo.ParametrosFinanceiros.DataInicio
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[ParametrosFinanceiros]')
      AND c.name = N'DataInicio';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[ParametrosFinanceiros] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[ParametrosFinanceiros]
        ADD CONSTRAINT [DF_ParametrosFinanceiros_DataInicio]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataInicio];

    -- dbo.ParametrosSistema.DataAtualizacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[ParametrosSistema]')
      AND c.name = N'DataAtualizacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[ParametrosSistema] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[ParametrosSistema]
        ADD CONSTRAINT [DF_ParametrosSistema_DataAtualizacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataAtualizacao];

    -- dbo.PontuacaoRegras.DataAtualizacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[PontuacaoRegras]')
      AND c.name = N'DataAtualizacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[PontuacaoRegras] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[PontuacaoRegras]
        ADD CONSTRAINT [DF_PontuacaoRegras_DataAtualizacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataAtualizacao];

    -- dbo.PontuacoesEventos.DataCriacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[PontuacoesEventos]')
      AND c.name = N'DataCriacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[PontuacoesEventos] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[PontuacoesEventos]
        ADD CONSTRAINT [DF_PontuacoesEventos_DataCriacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataCriacao];

    -- dbo.Prontuarios.DataCriacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Prontuarios]')
      AND c.name = N'DataCriacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Prontuarios] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Prontuarios]
        ADD CONSTRAINT [DF_Prontuarios_DataCriacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataCriacao];

    -- dbo.RankingUpdateLogs.ExecutadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[RankingUpdateLogs]')
      AND c.name = N'ExecutadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[RankingUpdateLogs] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[RankingUpdateLogs]
        ADD CONSTRAINT [DF_RankingUpdateLogs_ExecutadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [ExecutadoEm];

    -- dbo.Recibos.DataGeracao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Recibos]')
      AND c.name = N'DataGeracao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Recibos] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Recibos]
        ADD CONSTRAINT [DF_Recibos_DataGeracao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataGeracao];

    -- dbo.RedefinicoesSenha.AtualizadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[RedefinicoesSenha]')
      AND c.name = N'AtualizadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[RedefinicoesSenha] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[RedefinicoesSenha]
        ADD CONSTRAINT [DF_RedefinicoesSenha_AtualizadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [AtualizadoEm];

    -- dbo.RedefinicoesSenha.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[RedefinicoesSenha]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[RedefinicoesSenha] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[RedefinicoesSenha]
        ADD CONSTRAINT [DF_RedefinicoesSenha_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.RefreshTokens.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[RefreshTokens]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[RefreshTokens] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[RefreshTokens]
        ADD CONSTRAINT [DF_RefreshTokens_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.RelatoriosFinanceirosMensais.DataGeracao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[RelatoriosFinanceirosMensais]')
      AND c.name = N'DataGeracao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[RelatoriosFinanceirosMensais] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[RelatoriosFinanceirosMensais]
        ADD CONSTRAINT [DF_RelatoriosFinanceirosMensais_DataGeracao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataGeracao];

    -- dbo.RelatoriosFisioterapeutas.GeradoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[RelatoriosFisioterapeutas]')
      AND c.name = N'GeradoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[RelatoriosFisioterapeutas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[RelatoriosFisioterapeutas]
        ADD CONSTRAINT [DF_RelatoriosFisioterapeutas_GeradoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [GeradoEm];

    -- dbo.Taxas.DataInicio
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Taxas]')
      AND c.name = N'DataInicio';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Taxas] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Taxas]
        ADD CONSTRAINT [DF_Taxas_DataInicio]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataInicio];

    -- dbo.Transacoes.DataCriacao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[Transacoes]')
      AND c.name = N'DataCriacao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[Transacoes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[Transacoes]
        ADD CONSTRAINT [DF_Transacoes_DataCriacao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataCriacao];

    -- dbo.UsuariosEmailsUnicos.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[UsuariosEmailsUnicos]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[UsuariosEmailsUnicos] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[UsuariosEmailsUnicos]
        ADD CONSTRAINT [DF_UsuariosEmailsUnicos_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.UsuariosTelefonesUnicos.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[UsuariosTelefonesUnicos]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[UsuariosTelefonesUnicos] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[UsuariosTelefonesUnicos]
        ADD CONSTRAINT [DF_UsuariosTelefonesUnicos_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- dbo.VerificacoesContato.CriadoEm
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[VerificacoesContato]')
      AND c.name = N'CriadoEm';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [dbo].[VerificacoesContato] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [dbo].[VerificacoesContato]
        ADD CONSTRAINT [DF_VerificacoesContato_CriadoEm]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [CriadoEm];

    -- logs.AuditoriaEventos.DataAlteracao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[logs].[AuditoriaEventos]')
      AND c.name = N'DataAlteracao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [logs].[AuditoriaEventos] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [logs].[AuditoriaEventos]
        ADD CONSTRAINT [DF_AuditoriaEventos_DataAlteracao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataAlteracao];

    -- logs.AuditoriaIntegridade.DataExecucao
    SET @ConstraintName = NULL;

    SELECT @ConstraintName = dc.name
    FROM sys.default_constraints AS dc
    INNER JOIN sys.columns AS c
        ON c.object_id = dc.parent_object_id
       AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'[logs].[AuditoriaIntegridade]')
      AND c.name = N'DataExecucao';

    IF @ConstraintName IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE [logs].[AuditoriaIntegridade] DROP CONSTRAINT ' + QUOTENAME(@ConstraintName) + N';';
        EXEC sp_executesql @sql;
    END;

    ALTER TABLE [logs].[AuditoriaIntegridade]
        ADD CONSTRAINT [DF_AuditoriaIntegridade_DataExecucao]
        DEFAULT (CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FOR [DataExecucao];

    COMMIT TRAN;

    SELECT
        CAST(1 AS BIT) AS Sucesso,
        N'AZURE_TIMEZONE_DEFAULTS_V116 aplicado. Defaults de data/hora de negocio passam a usar fallback Sao Paulo.' AS Mensagem;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK TRAN;

    THROW;
END CATCH;
GO

/*
Validacao pos-aplicacao:

1) Nao deve retornar linhas para defaults de relogio local antigo:
SELECT
    OBJECT_SCHEMA_NAME(parent_object_id) AS SchemaName,
    OBJECT_NAME(parent_object_id) AS TableName,
    name AS ConstraintName,
    definition
FROM sys.default_constraints
WHERE LOWER(definition) LIKE '%getdate%'
   OR LOWER(definition) LIKE '%sysdatetime%' ;

2) Smoke test recomendado: inserir uma linha descartavel em uma tabela segura de log/cache
   e confirmar que a coluna com default grava horario de Brasilia no Azure.
*/

