SET XACT_ABORT ON;
GO

/****** Object:  StoredProcedure [analytics].[SP_AtualizarFisioPerformanceMensalResumo]    Script Date: 22/06/2026 09:39:11 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE OR ALTER PROCEDURE [analytics].[SP_AtualizarFisioPerformanceMensalResumo]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @Inicio DATETIME2(3) = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))),
        @Fim DATETIME2(3),
        @DuracaoSegundos INT,

        @RowsFonte BIGINT = 0,
        @LinhasAntes BIGINT = 0,
        @Inseridas BIGINT = 0,
        @LinhasDepois BIGINT = 0,

        @Mensagem NVARCHAR(4000) = N'',
        @Status NVARCHAR(20) = N'Sucesso',

        @UsuarioExecucao NVARCHAR(200) = SUSER_SNAME(),
        @OriginalLogin   NVARCHAR(200) = ORIGINAL_LOGIN(),
        @Servidor        NVARCHAR(200) = HOST_NAME(),

        @CtxTipo NVARCHAR(40),
        @CtxId INT,
        @AdminId INT,
        @ReadOnly BIT = 0,

        @lockResult INT,
        @HasLock BIT = 0,
        @Tentativas INT = 0,
        @MaxTentativas INT = 60,

        @FonteMaxMes CHAR(7);

    BEGIN TRY
        /* 1) AppLock com retry */
        WHILE (@Tentativas < @MaxTentativas)
        BEGIN
            EXEC @lockResult = sp_getapplock
                @Resource = N'cache.FisioPerformanceMensalResumo',
                @LockMode = N'Exclusive',
                @LockOwner = N'Session',
                @LockTimeout = 0;

            IF (@lockResult >= 0)
            BEGIN
                SET @HasLock = 1;
                BREAK;
            END

            SET @Tentativas += 1;
            WAITFOR DELAY '00:00:05';
        END

        IF (@HasLock = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Execução pulada: não foi possível obter AppLock.'
                + N' | Tentativas=' + CAST(@MaxTentativas AS NVARCHAR(10))
                + N' | Usuario=' + ISNULL(@UsuarioExecucao, N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin, N'?');

            IF OBJECT_ID(N'cache.LogAtualizacaoCache', N'U') IS NOT NULL
            BEGIN
                INSERT INTO cache.LogAtualizacaoCache
                    (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
                VALUES
                    (N'FisioPerformanceMensalResumo', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao,
                     N'analytics.SP_AtualizarFisioPerformanceMensalResumo', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));
            END

            RETURN;
        END

        /* 2) Contexto Admin (bypass RLS) */
        SELECT
            @CtxTipo = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)),
            @CtxId   = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));

        SELECT TOP (1) @AdminId = Id
        FROM dbo.Administradores
        WHERE Ativo = 1
        ORDER BY Id;

        IF @AdminId IS NULL
            THROW 51001, 'Nenhum Administrador Ativo encontrado para setar contexto Admin.', 1;

        IF (@UsuarioExecucao = N'NT SERVICE\SQLSERVERAGENT' OR PROGRAM_NAME() LIKE N'SQLAgent%')
            SET @ReadOnly = 1;

        IF (@CtxTipo IS NULL OR @CtxId IS NULL)
        BEGIN
            EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin', @read_only = @ReadOnly;
            EXEC sys.sp_set_session_context @key = N'UsuarioId',   @value = @AdminId,  @read_only = @ReadOnly;
        END

        /* 3) Fonte */
        SELECT @RowsFonte = COUNT_BIG(1)
        FROM analytics.vw_FisioPerformanceMensalResumo_Fonte;

        SELECT @FonteMaxMes = MAX(MesReferencia)
        FROM analytics.vw_FisioPerformanceMensalResumo_Fonte;

        IF (@RowsFonte = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Fonte retornou 0 linhas (cache preservado).'
                + N' | FonteMaxMes=' + ISNULL(@FonteMaxMes, N'NULL')
                + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
                + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
                + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

            IF OBJECT_ID(N'cache.LogAtualizacaoCache', N'U') IS NOT NULL
            BEGIN
                INSERT INTO cache.LogAtualizacaoCache
                    (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
                VALUES
                    (N'FisioPerformanceMensalResumo', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao,
                     N'analytics.SP_AtualizarFisioPerformanceMensalResumo', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));
            END

            EXEC sp_releaseapplock @Resource = N'cache.FisioPerformanceMensalResumo', @LockOwner = N'Session';
            RETURN;
        END

        /* 4) Atualiza cache */
        BEGIN TRAN;

        SELECT @LinhasAntes = COUNT_BIG(1) FROM cache.FisioPerformanceMensalResumo;

        TRUNCATE TABLE cache.FisioPerformanceMensalResumo;

        INSERT INTO cache.FisioPerformanceMensalResumo
        (
            MesReferencia,
            FisioterapeutaId,
            QtdeConsultas,
            ValorBruto,
            ValorLiquido,
            FisioAtivos,
            FisioInativos,
            FisioReativados,
            PercentualChurn,
            PercentualReativacao,
            DataAtualizacao
        )
        SELECT
            v.MesReferencia,
            v.FisioterapeutaId,
            v.QtdeConsultas,
            v.ValorBruto,
            v.ValorLiquido,
            v.FisioAtivos,
            v.FisioInativos,
            v.FisioReativados,
            v.PercentualChurn,
            v.PercentualReativacao,
            COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FROM analytics.vw_FisioPerformanceMensalResumo_Fonte v;

        SET @Inseridas = @@ROWCOUNT;

        SELECT @LinhasDepois = COUNT_BIG(1) FROM cache.FisioPerformanceMensalResumo;

        COMMIT;

        /* 5) Log sucesso */
        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

        SET @Mensagem =
            N'Cache atualizado com sucesso: cache.FisioPerformanceMensalResumo'
            + N' | LinhasAntes=' + CAST(@LinhasAntes AS NVARCHAR(40))
            + N' | RowsFonte='   + CAST(@RowsFonte   AS NVARCHAR(40))
            + N' | Inseridas='   + CAST(@Inseridas   AS NVARCHAR(40))
            + N' | LinhasDepois='+ CAST(@LinhasDepois AS NVARCHAR(40))
            + N' | FonteMaxMes=' + ISNULL(@FonteMaxMes, N'NULL')
            + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
            + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
            + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
            + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

        IF OBJECT_ID(N'cache.LogAtualizacaoCache', N'U') IS NOT NULL
        BEGIN
            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'FisioPerformanceMensalResumo', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao,
                 N'analytics.SP_AtualizarFisioPerformanceMensalResumo', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));
        END

        EXEC sp_releaseapplock @Resource = N'cache.FisioPerformanceMensalResumo', @LockOwner = N'Session';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);
        SET @Status = N'Falha';

        SET @Mensagem =
            N'Falha ao atualizar cache.FisioPerformanceMensalResumo'
            + N' | Erro=' + ERROR_MESSAGE()
            + N' | Linha=' + CAST(ERROR_LINE() AS NVARCHAR(10))
            + N' | Proc=' + ISNULL(ERROR_PROCEDURE(), N'?');

        IF OBJECT_ID(N'cache.LogAtualizacaoCache', N'U') IS NOT NULL
        BEGIN
            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'FisioPerformanceMensalResumo', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao,
                 N'analytics.SP_AtualizarFisioPerformanceMensalResumo', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));
        END

        IF (@HasLock = 1)
            EXEC sp_releaseapplock @Resource = N'cache.FisioPerformanceMensalResumo', @LockOwner = N'Session';

        THROW;
    END CATCH
END;
GO
/****** Object:  StoredProcedure [dbo].[SP_AtualizarCacheRankingFisioterapeutas]    Script Date: 22/06/2026 09:39:11 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_AtualizarCacheRankingFisioterapeutas]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @Inicio DATETIME2(3) = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))),
        @Fim DATETIME2(3),
        @DuracaoSegundos INT,

        @RowsFonte BIGINT = 0,
        @LinhasAntes BIGINT = 0,
        @Inseridas BIGINT = 0,
        @LinhasDepois BIGINT = 0,

        @Mensagem NVARCHAR(4000) = N'',
        @Status NVARCHAR(20) = N'Sucesso',

        @UsuarioExecucao NVARCHAR(200) = SUSER_SNAME(),
        @OriginalLogin   NVARCHAR(200) = ORIGINAL_LOGIN(),
        @Servidor        NVARCHAR(200) = HOST_NAME(),

        @CtxTipo NVARCHAR(40),
        @CtxId INT,
        @AdminId INT,
        @ReadOnly BIT = 0,

        @lockResult INT,
        @HasLock BIT = 0,
        @Tentativas INT = 0,
        @MaxTentativas INT = 60;

    BEGIN TRY
        /* =========================
           1) AppLock com retry
        ========================= */
        WHILE (@Tentativas < @MaxTentativas)
        BEGIN
            EXEC @lockResult = sp_getapplock
                @Resource = N'dbo.CacheRankingFisioterapeutas',
                @LockMode = N'Exclusive',
                @LockOwner = N'Session',
                @LockTimeout = 0;

            IF (@lockResult >= 0)
            BEGIN
                SET @HasLock = 1;
                BREAK;
            END

            SET @Tentativas += 1;
            WAITFOR DELAY '00:00:05';
        END

        IF (@HasLock = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Execução pulada: não foi possível obter AppLock (provável concorrência ou sessão antiga segurando lock).'
                + N' | Tentativas=' + CAST(@MaxTentativas AS NVARCHAR(10))
                + N' | Usuario=' + ISNULL(@UsuarioExecucao, N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin, N'?');

            IF OBJECT_ID(N'cache.LogAtualizacaoCache', N'U') IS NOT NULL
            BEGIN
                INSERT INTO cache.LogAtualizacaoCache
                    (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
                VALUES
                    (N'CacheRankingFisioterapeutas', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarCacheRankingFisioterapeutas', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));
            END

            RETURN;
        END

        /* =========================
           2) Contexto Admin (bypass RLS)
        ========================= */
        SELECT
            @CtxTipo = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)),
            @CtxId   = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));

        SELECT TOP (1) @AdminId = Id
        FROM dbo.Administradores
        WHERE Ativo = 1
        ORDER BY Id;

        IF @AdminId IS NULL
            THROW 51001, 'Nenhum Administrador Ativo encontrado para setar contexto Admin.', 1;

        IF (@UsuarioExecucao = N'NT SERVICE\SQLSERVERAGENT' OR PROGRAM_NAME() LIKE N'SQLAgent%')
            SET @ReadOnly = 1;

        -- Só seta se ainda não houver contexto (evita erro de read_only em sessão já “travada”)
        IF (@CtxTipo IS NULL OR @CtxId IS NULL)
        BEGIN
            EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin', @read_only = @ReadOnly;
            EXEC sys.sp_set_session_context @key = N'UsuarioId',   @value = @AdminId,  @read_only = @ReadOnly;
        END

        /* =========================
           3) Fonte
        ========================= */
        SELECT @RowsFonte = COUNT_BIG(1)
        FROM analytics.vw_CacheRankingFisioterapeutas_Fonte;

        IF (@RowsFonte = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Fonte retornou 0 linhas (cache preservado).'
                + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
                + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
                + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

            IF OBJECT_ID(N'cache.LogAtualizacaoCache', N'U') IS NOT NULL
            BEGIN
                INSERT INTO cache.LogAtualizacaoCache
                    (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
                VALUES
                    (N'CacheRankingFisioterapeutas', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarCacheRankingFisioterapeutas', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));
            END

            EXEC sp_releaseapplock @Resource = N'dbo.CacheRankingFisioterapeutas', @LockOwner = N'Session';
            RETURN;
        END

        /* =========================
           4) Atualiza cache
        ========================= */
        BEGIN TRAN;

        SELECT @LinhasAntes = COUNT_BIG(1) FROM dbo.CacheRankingFisioterapeutas;

        TRUNCATE TABLE dbo.CacheRankingFisioterapeutas;

        INSERT INTO dbo.CacheRankingFisioterapeutas
        (
            FisioterapeutaId,
            Nome,
            Cidade,
            Estado,
            ValorConsultaBase,
            DescontoPacote,
            Reputacao,
            PontuacaoFinal,
            Categoria,
            TipoConta,
            Destaque,
            TotalConsultas,
            TotalAvaliacoes,
            MediaAvaliacoes,
            PosicaoRanking,
            DataAtualizacao
        )
        SELECT
            FisioterapeutaId,
            Nome,
            Cidade,
            Estado,
            ValorConsultaBase,
            DescontoPacote,
            Reputacao,
            PontuacaoFinal,
            Categoria,
            TipoConta,
            Destaque,
            TotalConsultas,
            TotalAvaliacoes,
            MediaAvaliacoes,
            PosicaoRanking,
            COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FROM analytics.vw_CacheRankingFisioterapeutas_Fonte;

        SET @Inseridas = @@ROWCOUNT;

        SELECT @LinhasDepois = COUNT_BIG(1) FROM dbo.CacheRankingFisioterapeutas;

        COMMIT;

        /* =========================
           5) Log sucesso
        ========================= */
        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

        SET @Mensagem =
            N'Cache atualizado com sucesso: dbo.CacheRankingFisioterapeutas'
            + N' | LinhasAntes=' + CAST(@LinhasAntes AS NVARCHAR(40))
            + N' | RowsFonte='   + CAST(@RowsFonte   AS NVARCHAR(40))
            + N' | Inseridas='   + CAST(@Inseridas   AS NVARCHAR(40))
            + N' | LinhasDepois='+ CAST(@LinhasDepois AS NVARCHAR(40))
            + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
            + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
            + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
            + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

        IF OBJECT_ID(N'cache.LogAtualizacaoCache', N'U') IS NOT NULL
        BEGIN
            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'CacheRankingFisioterapeutas', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarCacheRankingFisioterapeutas', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));
        END

        EXEC sp_releaseapplock @Resource = N'dbo.CacheRankingFisioterapeutas', @LockOwner = N'Session';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);
        SET @Status = N'Falha';

        SET @Mensagem =
            N'Falha ao atualizar dbo.CacheRankingFisioterapeutas'
            + N' | Erro=' + ERROR_MESSAGE()
            + N' | Linha=' + CAST(ERROR_LINE() AS NVARCHAR(10))
            + N' | Proc=' + ISNULL(ERROR_PROCEDURE(), N'?');

        IF OBJECT_ID(N'cache.LogAtualizacaoCache', N'U') IS NOT NULL
        BEGIN
            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'CacheRankingFisioterapeutas', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarCacheRankingFisioterapeutas', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));
        END

        IF (@HasLock = 1)
            EXEC sp_releaseapplock @Resource = N'dbo.CacheRankingFisioterapeutas', @LockOwner = N'Session';

        ;THROW; -- <-- GARANTIDO dentro do CATCH
    END CATCH
END;
GO
/****** Object:  StoredProcedure [dbo].[SP_AtualizarDashboardGerencial]    Script Date: 22/06/2026 09:39:11 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

/* ============================================================
   4) Refresh do cache incluindo CustoGateway
   ============================================================ */
CREATE OR ALTER PROCEDURE [dbo].[SP_AtualizarDashboardGerencial]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @Inicio DATETIME2(3) = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))),
        @Fim DATETIME2(3),
        @DuracaoSegundos INT,

        @RowsFonte BIGINT = 0,
        @LinhasAntes BIGINT = 0,
        @Inseridas BIGINT = 0,
        @LinhasDepois BIGINT = 0,

        @Mensagem NVARCHAR(4000) = N'',
        @Status NVARCHAR(20) = N'Sucesso',

        @UsuarioExecucao NVARCHAR(200) = SUSER_SNAME(),
        @OriginalLogin NVARCHAR(200) = ORIGINAL_LOGIN(),
        @Servidor NVARCHAR(200) = HOST_NAME(),
        @Programa NVARCHAR(200) = PROGRAM_NAME(),

        @CtxTipo NVARCHAR(40),
        @CtxId INT,
        @AdminId INT,

        @lockResult INT,
        @LockAcquired BIT = 0,

        @Tentativas INT = 0,
        @MaxTentativas INT = 60;

    BEGIN TRY
        WHILE (@Tentativas < @MaxTentativas AND @LockAcquired = 0)
        BEGIN
            EXEC @lockResult = sp_getapplock
                @Resource = N'cache.DashboardGerencial',
                @LockMode = N'Exclusive',
                @LockOwner = N'Session',
                @LockTimeout = 0;

            IF (@lockResult >= 0)
            BEGIN
                SET @LockAcquired = 1;
                BREAK;
            END

            SET @Tentativas += 1;
            WAITFOR DELAY '00:00:05';
        END

        IF (@LockAcquired = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Execucao pulada: nao foi possivel obter AppLock (provavel concorrencia ou sessao antiga segurando lock).'
                + N' | Tentativas=' + CAST(@MaxTentativas AS NVARCHAR(10))
                + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
                + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
                + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'DashboardGerencial', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarDashboardGerencial', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            RETURN;
        END

        SELECT
            @CtxTipo = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)),
            @CtxId   = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));

        IF (@CtxTipo IS NULL OR @CtxTipo <> N'Admin' OR @CtxId IS NULL)
        BEGIN
            SELECT TOP (1) @AdminId = Id
            FROM dbo.Administradores
            WHERE Ativo = 1
            ORDER BY Id;

            IF @AdminId IS NULL
                THROW 51001, 'Nenhum Administrador Ativo encontrado para setar contexto Admin.', 1;

            EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin';
            EXEC sys.sp_set_session_context @key = N'UsuarioId',   @value = @AdminId;
        END

        SELECT @RowsFonte = COUNT_BIG(1)
        FROM analytics.vw_DashboardGerencial_Fonte;

        IF (@RowsFonte = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem = N'Fonte retornou 0 linhas (cache preservado).'
                          + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
                          + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
                          + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
                          + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'DashboardGerencial', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarDashboardGerencial', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            EXEC sp_releaseapplock @Resource = N'cache.DashboardGerencial', @LockOwner = N'Session';
            RETURN;
        END

        BEGIN TRAN;

        SELECT @LinhasAntes = COUNT_BIG(1) FROM cache.DashboardGerencial;

        TRUNCATE TABLE cache.DashboardGerencial;

        INSERT INTO cache.DashboardGerencial (
            Periodo, ReceitaBruta, DespesasTotais, CustoGateway, LucroLiquido, MargemPct,
            Enquadramento, TaxaIntermediacao, TaxaGateway, TaxaServico,
            ReceitaTotal, LucroTotal, ROI_Pct, CAGR_Pct, MargemLiquidaPct,
            ReceitaMediaMensal, LucroMedioMensal, Fisioterapeuta, TotalConsultas,
            ReceitaGerada, ParticipacaoPct, Cidade, Estado, ConsultasCidade,
            ReceitaCidade, BreakEvenEstimado, DiferencaBreakEvenLucroOperacional,
            UltimaAtualizacao
        )
        SELECT
            Periodo, ReceitaBruta, DespesasTotais, CustoGateway, LucroLiquido, MargemPct,
            Enquadramento, TaxaIntermediacao, TaxaGateway, TaxaServico,
            ReceitaTotal, LucroTotal, ROI_Pct, CAGR_Pct, MargemLiquidaPct,
            ReceitaMediaMensal, LucroMedioMensal, Fisioterapeuta, TotalConsultas,
            ReceitaGerada, ParticipacaoPct, Cidade, Estado, ConsultasCidade,
            ReceitaCidade, BreakEvenEstimado, DiferencaBreakEvenLucroOperacional,
            UltimaAtualizacao
        FROM analytics.vw_DashboardGerencial_Fonte;

        SET @Inseridas = @@ROWCOUNT;

        SELECT @LinhasDepois = COUNT_BIG(1) FROM cache.DashboardGerencial;

        COMMIT;

        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

        SET @Mensagem =
            N'Cache atualizado com sucesso: cache.DashboardGerencial'
            + N' | LinhasAntes=' + CAST(@LinhasAntes AS NVARCHAR(40))
            + N' | RowsFonte='   + CAST(@RowsFonte   AS NVARCHAR(40))
            + N' | Inseridas='   + CAST(@Inseridas   AS NVARCHAR(40))
            + N' | LinhasDepois='+ CAST(@LinhasDepois AS NVARCHAR(40))
            + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
            + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
            + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
            + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'DashboardGerencial', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarDashboardGerencial', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

        EXEC sp_releaseapplock @Resource = N'cache.DashboardGerencial', @LockOwner = N'Session';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        BEGIN TRY
            IF (@LockAcquired = 1)
                EXEC sp_releaseapplock @Resource = N'cache.DashboardGerencial', @LockOwner = N'Session';
        END TRY
        BEGIN CATCH
        END CATCH

        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

        SET @Status = N'Falha';
        SET @Mensagem =
            N'Falha ao atualizar cache.DashboardGerencial'
            + N' | Erro=' + ERROR_MESSAGE()
            + N' | Linha=' + CAST(ERROR_LINE() AS NVARCHAR(10))
            + N' | Proc=' + ISNULL(ERROR_PROCEDURE(), N'?')
            + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
            + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
            + N' | Programa=' + ISNULL(@Programa,N'?');

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'DashboardGerencial', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarDashboardGerencial', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

        THROW;
    END CATCH
END;
GO
/****** Object:  StoredProcedure [dbo].[SP_AtualizarFisioAvaliacoesMedia]    Script Date: 22/06/2026 09:39:11 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_AtualizarFisioAvaliacoesMedia]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @Inicio DATETIME2(3) = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))),
        @Fim DATETIME2(3),
        @DuracaoSegundos INT,
        @RowsFonte BIGINT = 0,
        @LinhasAntes BIGINT = 0,
        @Inseridas BIGINT = 0,
        @LinhasDepois BIGINT = 0,
        @Mensagem NVARCHAR(4000) = N'',
        @Status NVARCHAR(20) = N'Sucesso',
        @UsuarioExecucao NVARCHAR(200) = SUSER_SNAME(),
        @OriginalLogin NVARCHAR(200) = ORIGINAL_LOGIN(),
        @Servidor NVARCHAR(200) = HOST_NAME(),
        @CtxTipo NVARCHAR(40),
        @CtxId INT,
        @AdminId INT,
        @ReadOnly BIT = 0,
        @LockResult INT,
        @LockAcquired BIT = 0,
        @Tentativas INT = 0,
        @TentativasMax INT = 60;

    BEGIN TRY
        /* =========================
           1) AppLock (com retry)
           ========================= */
        WHILE (@Tentativas < @TentativasMax)
        BEGIN
            EXEC @LockResult = sp_getapplock
                @Resource = N'cache.FisioAvaliacoesMedia',
                @LockMode = N'Exclusive',
                @LockOwner = N'Session',
                @LockTimeout = 0;

            IF (@LockResult >= 0)
            BEGIN
                SET @LockAcquired = 1;
                BREAK;
            END

            SET @Tentativas += 1;
            WAITFOR DELAY '00:00:01';
        END

        IF (@LockAcquired = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Execução pulada: não foi possível obter AppLock (provável concorrência ou sessão antiga segurando lock).'
                + N' | Tentativas=' + CAST(@TentativasMax AS NVARCHAR(10))
                + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
                + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
                + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'FisioAvaliacoesMedia', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioAvaliacoesMedia', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            RETURN;
        END

        /* =========================
           2) Contexto Admin (bypass RLS)
           ========================= */
        SELECT
            @CtxTipo = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)),
            @CtxId   = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));

        SELECT TOP (1) @AdminId = Id
        FROM dbo.Administradores
        WHERE Ativo = 1
        ORDER BY Id;

        IF @AdminId IS NULL
            THROW 51001, 'Nenhum Administrador Ativo encontrado para setar contexto Admin.', 1;

        IF (@UsuarioExecucao = N'NT SERVICE\SQLSERVERAGENT' OR PROGRAM_NAME() LIKE N'SQLAgent%')
            SET @ReadOnly = 1;

        IF (@CtxTipo IS NULL OR @CtxTipo <> N'Admin' OR @CtxId IS NULL)
        BEGIN
            BEGIN TRY
                EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin', @read_only = @ReadOnly;
            END TRY
            BEGIN CATCH
                IF ERROR_NUMBER() <> 15664 THROW; -- ignora "read_only já definido"
            END CATCH;

            BEGIN TRY
                EXEC sys.sp_set_session_context @key = N'UsuarioId', @value = @AdminId, @read_only = @ReadOnly;
            END TRY
            BEGIN CATCH
                IF ERROR_NUMBER() <> 15664 THROW;
            END CATCH;
        END

        /* =========================
           3) Fonte
           ========================= */
        SELECT @RowsFonte = COUNT_BIG(1)
        FROM analytics.vw_FisioAvaliacoesMedia;

        IF (@RowsFonte = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem = N'Fonte retornou 0 linhas (cache preservado).'
                          + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
                          + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
                          + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
                          + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'FisioAvaliacoesMedia', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioAvaliacoesMedia', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            RETURN;
        END

        /* =========================
           4) Atualiza cache
           ========================= */
        BEGIN TRAN;

        SELECT @LinhasAntes = COUNT_BIG(1) FROM cache.FisioAvaliacoesMedia;

        TRUNCATE TABLE cache.FisioAvaliacoesMedia;

        INSERT INTO cache.FisioAvaliacoesMedia (FisioterapeutaId, MediaNota, TotalAvaliacoes, UltimaAvaliacao, AtualizadoEm)
        SELECT
            FisioterapeutaId,
            MediaNota,
            ISNULL(TotalAvaliacoes, 0),
            UltimaAvaliacao,
            COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)))
        FROM analytics.vw_FisioAvaliacoesMedia;

        SET @Inseridas = @@ROWCOUNT;

        SELECT @LinhasDepois = COUNT_BIG(1) FROM cache.FisioAvaliacoesMedia;

        COMMIT;

        /* =========================
           5) Log sucesso
           ========================= */
        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

        SET @Mensagem =
            N'Cache atualizado com sucesso: cache.FisioAvaliacoesMedia'
            + N' | LinhasAntes=' + CAST(@LinhasAntes AS NVARCHAR(40))
            + N' | RowsFonte='   + CAST(@RowsFonte   AS NVARCHAR(40))
            + N' | Inseridas='   + CAST(@Inseridas   AS NVARCHAR(40))
            + N' | LinhasDepois='+ CAST(@LinhasDepois AS NVARCHAR(40))
            + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
            + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
            + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
            + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'FisioAvaliacoesMedia', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioAvaliacoesMedia', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);
        SET @Status = N'Falha';
        SET @Mensagem = ERROR_MESSAGE();

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'FisioAvaliacoesMedia', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioAvaliacoesMedia', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

        THROW;
    END CATCH
    -- libera lock SEMPRE (evita SSMS segurar lock e travar SQL Agent)
    BEGIN TRY
        IF (@LockAcquired = 1)
            EXEC sp_releaseapplock @Resource = N'cache.FisioAvaliacoesMedia', @LockOwner = N'Session';
    END TRY
    BEGIN CATCH
        -- não estoura erro por falha de release
    END CATCH
END;
GO
/****** Object:  StoredProcedure [dbo].[SP_AtualizarFisioConsultasResumo]    Script Date: 22/06/2026 09:39:11 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_AtualizarFisioConsultasResumo]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @Inicio DATETIME2(3) = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))),
        @Fim DATETIME2(3),
        @DuracaoSegundos INT,

        @RowsFonte BIGINT = 0,
        @FonteMaxUltimaConsulta DATETIME = NULL,

        @LinhasAntes BIGINT = 0,
        @Inseridas BIGINT = 0,
        @LinhasDepois BIGINT = 0,

        @Mensagem NVARCHAR(4000) = N'',
        @Status NVARCHAR(20) = N'Sucesso',

        @UsuarioExecucao NVARCHAR(200) = SUSER_SNAME(),
        @OriginalLogin   NVARCHAR(200) = ORIGINAL_LOGIN(),
        @Servidor        NVARCHAR(200) = HOST_NAME(),

        @CtxTipo NVARCHAR(40),
        @CtxId INT,
        @AdminId INT,
        @ReadOnly BIT = 0,

        @lockResult INT,
        @HasLock BIT = 0,
        @Tentativas INT = 0,
        @MaxTentativas INT = 60;

    BEGIN TRY
        /* =========================
           1) AppLock com retry
        ========================= */
        WHILE (@Tentativas < @MaxTentativas)
        BEGIN
            EXEC @lockResult = sp_getapplock
                @Resource  = N'cache.FisioConsultasResumo',
                @LockMode  = N'Exclusive',
                @LockOwner = N'Session',
                @LockTimeout = 0;

            IF (@lockResult >= 0)
            BEGIN
                SET @HasLock = 1;
                BREAK;
            END

            SET @Tentativas += 1;
            WAITFOR DELAY '00:00:05';
        END

        IF (@HasLock = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Execução pulada: não foi possível obter AppLock (provável concorrência ou sessão antiga segurando lock).'
                + N' | Tentativas=' + CAST(@MaxTentativas AS NVARCHAR(10))
                + N' | Usuario=' + ISNULL(@UsuarioExecucao, N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin, N'?')
                + N' | Host=' + ISNULL(@Servidor, N'?');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'FisioConsultasResumo', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioConsultasResumo', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            RETURN;
        END

        /* =========================
           2) Contexto Admin (bypass RLS)
        ========================= */
        SELECT
            @CtxTipo = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)),
            @CtxId   = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));

        SELECT TOP (1) @AdminId = Id
        FROM dbo.Administradores
        WHERE Ativo = 1
        ORDER BY Id;

        IF @AdminId IS NULL
            THROW 51001, 'Nenhum Administrador Ativo encontrado para setar contexto Admin.', 1;

        IF (@UsuarioExecucao = N'NT SERVICE\SQLSERVERAGENT' OR PROGRAM_NAME() LIKE N'SQLAgent%')
            SET @ReadOnly = 1;

        IF (@CtxTipo IS NULL OR @CtxTipo <> N'Admin' OR @CtxId IS NULL)
        BEGIN
            -- se der erro read_only aqui, cai no CATCH e loga.
            EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin', @read_only = @ReadOnly;
            EXEC sys.sp_set_session_context @key = N'UsuarioId',   @value = @AdminId,  @read_only = @ReadOnly;
        END

        /* =========================
           3) Fonte
        ========================= */
        SELECT
            @RowsFonte = COUNT_BIG(1),
            @FonteMaxUltimaConsulta = MAX(UltimaConsulta)
        FROM analytics.vw_FisioConsultasResumo_Fonte;

        IF (@RowsFonte = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Fonte retornou 0 linhas (cache preservado).'
                + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
                + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
                + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'FisioConsultasResumo', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioConsultasResumo', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            EXEC sp_releaseapplock @Resource = N'cache.FisioConsultasResumo', @LockOwner = N'Session';
            RETURN;
        END

        /* =========================
           4) Atualiza cache
        ========================= */
        BEGIN TRAN;

        SELECT @LinhasAntes = COUNT_BIG(1) FROM cache.FisioConsultasResumo;

        TRUNCATE TABLE cache.FisioConsultasResumo;

        DECLARE @AtualizadoEm DATETIME2(3) = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));

        INSERT INTO cache.FisioConsultasResumo
            (FisioterapeutaId, TotalConsultas, ConsultasConcluidas, ConsultasCanceladas,
             PercentualCancelamento, UltimaConsulta, AtualizadoEm)
        SELECT
            FisioterapeutaId, TotalConsultas, ConsultasConcluidas, ConsultasCanceladas,
            PercentualCancelamento, UltimaConsulta, @AtualizadoEm
        FROM analytics.vw_FisioConsultasResumo_Fonte;

        SET @Inseridas = @@ROWCOUNT;

        SELECT @LinhasDepois = COUNT_BIG(1) FROM cache.FisioConsultasResumo;

        COMMIT;

        /* =========================
           5) Log sucesso
        ========================= */
        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

        SET @Mensagem =
            N'Cache atualizado com sucesso: cache.FisioConsultasResumo'
            + N' | LinhasAntes=' + CAST(@LinhasAntes AS NVARCHAR(40))
            + N' | RowsFonte='   + CAST(@RowsFonte   AS NVARCHAR(40))
            + N' | Inseridas='   + CAST(@Inseridas   AS NVARCHAR(40))
            + N' | LinhasDepois='+ CAST(@LinhasDepois AS NVARCHAR(40))
            + N' | FonteMaxUltimaConsulta=' + ISNULL(CONVERT(NVARCHAR(30), @FonteMaxUltimaConsulta, 121), N'NULL')
            + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
            + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
            + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
            + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'FisioConsultasResumo', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioConsultasResumo', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

        EXEC sp_releaseapplock @Resource = N'cache.FisioConsultasResumo', @LockOwner = N'Session';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);
        SET @Status = N'Falha';

        SET @Mensagem =
            N'Falha ao atualizar cache.FisioConsultasResumo'
            + N' | Erro=' + ERROR_MESSAGE()
            + N' | Linha=' + CAST(ERROR_LINE() AS NVARCHAR(10))
            + N' | Proc=' + ISNULL(ERROR_PROCEDURE(), N'?')
            + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
            + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?');

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'FisioConsultasResumo', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioConsultasResumo', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

        IF (@HasLock = 1)
            EXEC sp_releaseapplock @Resource = N'cache.FisioConsultasResumo', @LockOwner = N'Session';

        THROW;
    END CATCH
END
GO
/****** Object:  StoredProcedure [dbo].[SP_AtualizarFisioFinanceiroResumo]    Script Date: 22/06/2026 09:39:11 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE OR ALTER PROCEDURE [dbo].[SP_AtualizarFisioFinanceiroResumo]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @Inicio DATETIME2(3) = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))),
        @Fim DATETIME2(3),
        @DuracaoSegundos INT,

        @RowsFonte BIGINT = 0,
        @LinhasAntes BIGINT = 0,
        @Inseridas BIGINT = 0,
        @LinhasDepois BIGINT = 0,
        @FonteMaxUltimoPagamento DATETIME = NULL,

        @Mensagem NVARCHAR(4000) = N'',
        @Status NVARCHAR(20) = N'Sucesso',

        @UsuarioExecucao NVARCHAR(200) = SUSER_SNAME(),
        @OriginalLogin   NVARCHAR(200) = ORIGINAL_LOGIN(),
        @Servidor        NVARCHAR(200) = HOST_NAME(),

        @CtxTipo NVARCHAR(40),
        @CtxId INT,
        @AdminId INT,
        @ReadOnly BIT = 0,

        @lockResult INT,
        @HasLock BIT = 0,
        @Tentativas INT = 0,
        @MaxTentativas INT = 60;

    BEGIN TRY
        /* 1) AppLock com retry */
        WHILE (@Tentativas < @MaxTentativas)
        BEGIN
            EXEC @lockResult = sp_getapplock
                @Resource = N'cache.FisioFinanceiroResumo',
                @LockMode = N'Exclusive',
                @LockOwner = N'Session',
                @LockTimeout = 0;

            IF (@lockResult >= 0)
            BEGIN
                SET @HasLock = 1;
                BREAK;
            END

            SET @Tentativas += 1;
            WAITFOR DELAY '00:00:05';
        END

        IF (@HasLock = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Execução pulada: não foi possível obter AppLock (provável concorrência ou sessão antiga segurando lock).'
                + N' | Tentativas=' + CAST(@MaxTentativas AS NVARCHAR(10))
                + N' | Usuario=' + ISNULL(@UsuarioExecucao, N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin, N'?');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'FisioFinanceiroResumo', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioFinanceiroResumo', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            RETURN;
        END

        /* 2) Contexto Admin (bypass RLS) */
        SELECT
            @CtxTipo = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)),
            @CtxId   = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));

        SELECT TOP (1) @AdminId = Id
        FROM dbo.Administradores
        WHERE Ativo = 1
        ORDER BY Id;

        IF @AdminId IS NULL
            THROW 51001, 'Nenhum Administrador Ativo encontrado para setar contexto Admin.', 1;

        IF (@UsuarioExecucao = N'NT SERVICE\SQLSERVERAGENT' OR PROGRAM_NAME() LIKE N'SQLAgent%')
            SET @ReadOnly = 1;

        IF (@CtxTipo IS NULL)
        BEGIN
            EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin', @read_only = @ReadOnly;
            EXEC sys.sp_set_session_context @key = N'UsuarioId',   @value = @AdminId,  @read_only = @ReadOnly;
        END
        ELSE IF (@CtxTipo <> N'Admin')
        BEGIN
            THROW 51002, 'Sessão já possui UsuarioTipo diferente de Admin. Execute em nova sessão/step para atualizar caches.', 1;
        END

        /* 3) Fonte */
        SELECT
            @RowsFonte = COUNT_BIG(1),
            @FonteMaxUltimoPagamento = MAX(UltimoPagamento)
        FROM analytics.vw_FisioFinanceiroResumo_Fonte;

        IF (@RowsFonte = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Fonte retornou 0 linhas (cache preservado).'
                + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
                + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
                + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'FisioFinanceiroResumo', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioFinanceiroResumo', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            EXEC sp_releaseapplock @Resource = N'cache.FisioFinanceiroResumo', @LockOwner = N'Session';
            RETURN;
        END

        /* 4) Atualiza cache */
        BEGIN TRAN;

        SELECT @LinhasAntes = COUNT_BIG(1) FROM cache.FisioFinanceiroResumo;

        TRUNCATE TABLE cache.FisioFinanceiroResumo;

        DECLARE @Carimbo DATETIME2(3) = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));

        INSERT INTO cache.FisioFinanceiroResumo
            (FisioterapeutaId, FisioterapeutaNome, TotalRecebido, ValorPendente, ValorPago, TotalRepasses, UltimoPagamento, AtualizadoEm)
        SELECT
            FisioterapeutaId,
            FisioterapeutaNome,
            TotalRecebido,
            ValorPendente,
            ValorPago,
            TotalRepasses,
            UltimoPagamento,
            CAST(@Carimbo AS DATETIME)
        FROM analytics.vw_FisioFinanceiroResumo_Fonte;

        SET @Inseridas = @@ROWCOUNT;

        SELECT @LinhasDepois = COUNT_BIG(1) FROM cache.FisioFinanceiroResumo;

        COMMIT;

        /* 5) Log sucesso */
        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

        SET @Mensagem =
            N'Cache atualizado com sucesso: cache.FisioFinanceiroResumo'
            + N' | LinhasAntes=' + CAST(@LinhasAntes AS NVARCHAR(40))
            + N' | RowsFonte='   + CAST(@RowsFonte   AS NVARCHAR(40))
            + N' | Inseridas='   + CAST(@Inseridas   AS NVARCHAR(40))
            + N' | LinhasDepois='+ CAST(@LinhasDepois AS NVARCHAR(40))
            + N' | FonteMaxUltimoPagamento=' + ISNULL(CONVERT(NVARCHAR(30), @FonteMaxUltimoPagamento, 121), N'NULL')
            + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
            + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
            + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
            + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'FisioFinanceiroResumo', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioFinanceiroResumo', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

        EXEC sp_releaseapplock @Resource = N'cache.FisioFinanceiroResumo', @LockOwner = N'Session';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);
        SET @Status = N'Falha';

        SET @Mensagem =
            N'Falha ao atualizar cache.FisioFinanceiroResumo'
            + N' | Erro=' + ERROR_MESSAGE()
            + N' | Linha=' + CAST(ERROR_LINE() AS NVARCHAR(10))
            + N' | Proc=' + ISNULL(ERROR_PROCEDURE(), N'?');

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'FisioFinanceiroResumo', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioFinanceiroResumo', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

        IF (@HasLock = 1)
            EXEC sp_releaseapplock @Resource = N'cache.FisioFinanceiroResumo', @LockOwner = N'Session';

        THROW;
    END CATCH
END
GO
/****** Object:  StoredProcedure [dbo].[SP_AtualizarFisioPerformanceMensal]    Script Date: 22/06/2026 09:39:11 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_AtualizarFisioPerformanceMensal]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @Inicio DATETIME2(3) = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))),
        @Fim DATETIME2(3),
        @DuracaoSegundos INT,

        @RowsFonte BIGINT = 0,
        @LinhasAntes BIGINT = 0,
        @Inseridas BIGINT = 0,
        @LinhasDepois BIGINT = 0,

        @Mensagem NVARCHAR(4000) = N'',
        @Status NVARCHAR(20) = N'Sucesso',

        @UsuarioExecucao NVARCHAR(200) = SUSER_SNAME(),
        @OriginalLogin   NVARCHAR(200) = ORIGINAL_LOGIN(),
        @Servidor        NVARCHAR(200) = HOST_NAME(),

        @CtxTipo NVARCHAR(40),
        @CtxId INT,
        @AdminId INT,
        @ReadOnly BIT = 0,

        @lockResult INT,
        @HasLock BIT = 0,
        @Tentativas INT = 0,
        @MaxTentativas INT = 60,

        @Carimbo DATETIME = CAST(COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))) AS DATETIME),
        @FonteMaxPeriodo DATE;

    BEGIN TRY
        /* =========================
           1) AppLock com retry
        ========================= */
        WHILE (@Tentativas < @MaxTentativas)
        BEGIN
            EXEC @lockResult = sp_getapplock
                @Resource = N'cache.FisioPerformanceMensal',
                @LockMode = N'Exclusive',
                @LockOwner = N'Session',
                @LockTimeout = 0;

            IF (@lockResult >= 0)
            BEGIN
                SET @HasLock = 1;
                BREAK;
            END

            SET @Tentativas += 1;
            WAITFOR DELAY '00:00:05';
        END

        IF (@HasLock = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Execução pulada: não foi possível obter AppLock (provável concorrência ou sessão antiga segurando lock).'
                + N' | Tentativas=' + CAST(@MaxTentativas AS NVARCHAR(10))
                + N' | Usuario=' + ISNULL(@UsuarioExecucao, N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin, N'?');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'FisioPerformanceMensal', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioPerformanceMensal', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            RETURN;
        END

        /* =========================
           2) Contexto Admin (bypass RLS)
        ========================= */
        SELECT
            @CtxTipo = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)),
            @CtxId   = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));

        SELECT TOP (1) @AdminId = Id
        FROM dbo.Administradores
        WHERE Ativo = 1
        ORDER BY Id;

        IF @AdminId IS NULL
            THROW 51001, 'Nenhum Administrador Ativo encontrado para setar contexto Admin.', 1;

        IF (@UsuarioExecucao = N'NT SERVICE\SQLSERVERAGENT' OR PROGRAM_NAME() LIKE N'SQLAgent%')
            SET @ReadOnly = 1;

        IF (@CtxTipo IS NULL OR @CtxTipo <> N'Admin' OR @CtxId IS NULL)
        BEGIN
            EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin', @read_only = @ReadOnly;
            EXEC sys.sp_set_session_context @key = N'UsuarioId',   @value = @AdminId,  @read_only = @ReadOnly;
        END

        /* =========================
           3) Fonte
        ========================= */
        SELECT @RowsFonte = COUNT_BIG(1)
        FROM analytics.vw_FisioPerformanceMensal_Fonte;

        SELECT @FonteMaxPeriodo =
            MAX(CONVERT(date, DATEFROMPARTS(Ano, Mes, 1)))
        FROM analytics.vw_FisioPerformanceMensal_Fonte;

        IF (@RowsFonte = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Fonte retornou 0 linhas (cache preservado).'
                + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
                + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
                + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'FisioPerformanceMensal', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioPerformanceMensal', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            EXEC sp_releaseapplock @Resource = N'cache.FisioPerformanceMensal', @LockOwner = N'Session';
            RETURN;
        END

        /* =========================
           4) Atualiza cache
        ========================= */
        BEGIN TRAN;

        SELECT @LinhasAntes = COUNT_BIG(1) FROM cache.FisioPerformanceMensal;

        TRUNCATE TABLE cache.FisioPerformanceMensal;

        INSERT INTO cache.FisioPerformanceMensal
            (FisioterapeutaId, Ano, Mes,
             TotalConsultas, ConsultasConcluidas, ConsultasCanceladas,
             ReceitaBruta, ReceitaLiquida, MediaAvaliacoes,
             AtualizadoEm)
        SELECT
            FisioterapeutaId, Ano, Mes,
            TotalConsultas, ConsultasConcluidas, ConsultasCanceladas,
            ReceitaBruta, ReceitaLiquida, MediaAvaliacoes,
            @Carimbo
        FROM analytics.vw_FisioPerformanceMensal_Fonte;

        SET @Inseridas = @@ROWCOUNT;

        SELECT @LinhasDepois = COUNT_BIG(1) FROM cache.FisioPerformanceMensal;

        COMMIT;

        /* =========================
           5) Log sucesso
        ========================= */
        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

        SET @Mensagem =
            N'Cache atualizado com sucesso: cache.FisioPerformanceMensal'
            + N' | LinhasAntes=' + CAST(@LinhasAntes AS NVARCHAR(40))
            + N' | RowsFonte='   + CAST(@RowsFonte   AS NVARCHAR(40))
            + N' | Inseridas='   + CAST(@Inseridas   AS NVARCHAR(40))
            + N' | LinhasDepois='+ CAST(@LinhasDepois AS NVARCHAR(40))
            + N' | FonteMaxPeriodo=' + ISNULL(CONVERT(nvarchar(10), @FonteMaxPeriodo, 120), N'NULL')
            + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
            + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
            + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
            + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'FisioPerformanceMensal', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioPerformanceMensal', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

        EXEC sp_releaseapplock @Resource = N'cache.FisioPerformanceMensal', @LockOwner = N'Session';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);
        SET @Status = N'Falha';

        SET @Mensagem =
            N'Falha ao atualizar cache.FisioPerformanceMensal'
            + N' | Erro=' + ERROR_MESSAGE()
            + N' | Linha=' + CAST(ERROR_LINE() AS NVARCHAR(10))
            + N' | Proc=' + ISNULL(ERROR_PROCEDURE(), N'?');

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'FisioPerformanceMensal', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarFisioPerformanceMensal', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

        IF (@HasLock = 1)
            EXEC sp_releaseapplock @Resource = N'cache.FisioPerformanceMensal', @LockOwner = N'Session';

        THROW;
    END CATCH
END
GO
/****** Object:  StoredProcedure [dbo].[SP_AtualizarFisioPerformanceMensalResumo]    Script Date: 22/06/2026 09:39:11 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE OR ALTER PROCEDURE [dbo].[SP_AtualizarFisioPerformanceMensalResumo]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    EXEC analytics.SP_AtualizarFisioPerformanceMensalResumo @AgoraBrasil = @AgoraBrasil;
END;
GO
/****** Object:  StoredProcedure [dbo].[SP_AtualizarPipelineFinanceiro]    Script Date: 22/06/2026 09:39:11 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_AtualizarPipelineFinanceiro]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @Inicio DATETIME2(3) = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))),
        @Fim DATETIME2(3),
        @DuracaoSegundos INT,

        @RowsFonte BIGINT = 0,
        @LinhasAntes BIGINT = 0,
        @Inseridas BIGINT = 0,
        @LinhasDepois BIGINT = 0,

        @FonteMaxDataHora DATETIME = NULL,

        @Mensagem NVARCHAR(4000) = N'',
        @Status NVARCHAR(20) = N'Sucesso',

        @UsuarioExecucao NVARCHAR(200) = SUSER_SNAME(),
        @OriginalLogin   NVARCHAR(200) = ORIGINAL_LOGIN(),
        @Servidor        NVARCHAR(200) = HOST_NAME(),

        @CtxTipo NVARCHAR(40),
        @CtxId INT,
        @AdminId INT,
        @ReadOnly BIT = 0,

        @lockResult INT,
        @HasLock BIT = 0,
        @Tentativas INT = 0,
        @MaxTentativas INT = 60;

    BEGIN TRY
        /* =========================
           1) AppLock com retry
        ========================= */
        WHILE (@Tentativas < @MaxTentativas)
        BEGIN
            EXEC @lockResult = sp_getapplock
                @Resource = N'cache.PipelineFinanceiro',
                @LockMode = N'Exclusive',
                @LockOwner = N'Session',
                @LockTimeout = 0;

            IF (@lockResult >= 0)
            BEGIN
                SET @HasLock = 1;
                BREAK;
            END

            SET @Tentativas += 1;
            WAITFOR DELAY '00:00:05';
        END

        IF (@HasLock = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Execução pulada: não foi possível obter AppLock (provável concorrência/sessão antiga segurando lock).'
                + N' | Tentativas=' + CAST(@MaxTentativas AS NVARCHAR(10))
                + N' | Usuario=' + ISNULL(@UsuarioExecucao, N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin, N'?');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'PipelineFinanceiro', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarPipelineFinanceiro', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            RETURN;
        END

        /* =========================
           2) Contexto Admin (bypass RLS)
        ========================= */
        SELECT
            @CtxTipo = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)),
            @CtxId   = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));

        SELECT TOP (1) @AdminId = Id
        FROM dbo.Administradores
        WHERE Ativo = 1
        ORDER BY Id;

        IF @AdminId IS NULL
            THROW 51001, 'Nenhum Administrador Ativo encontrado para setar contexto Admin.', 1;

        IF (@UsuarioExecucao = N'NT SERVICE\SQLSERVERAGENT' OR PROGRAM_NAME() LIKE N'SQLAgent%')
            SET @ReadOnly = 1;

        -- Só tenta setar se ainda não tiver contexto (evita erro read_only)
        IF (@CtxTipo IS NULL OR @CtxTipo <> N'Admin' OR @CtxId IS NULL)
        BEGIN
            EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin', @read_only = @ReadOnly;
            EXEC sys.sp_set_session_context @key = N'UsuarioId',   @value = @AdminId,  @read_only = @ReadOnly;
        END

        /* =========================
           3) Fonte (view _Fonte)
        ========================= */
        SELECT
            @RowsFonte = COUNT_BIG(1),
            @FonteMaxDataHora = MAX(v.DataHora)
        FROM analytics.vw_PipelineFinanceiro_Fonte v;

        IF (@RowsFonte = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Fonte retornou 0 linhas (cache preservado).'
                + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
                + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
                + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'PipelineFinanceiro', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarPipelineFinanceiro', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            EXEC sp_releaseapplock @Resource = N'cache.PipelineFinanceiro', @LockOwner = N'Session';
            RETURN;
        END

        /* =========================
           4) Atualiza cache
        ========================= */
        BEGIN TRAN;

        SELECT @LinhasAntes = COUNT_BIG(1) FROM cache.PipelineFinanceiro;

        TRUNCATE TABLE cache.PipelineFinanceiro;

        INSERT INTO cache.PipelineFinanceiro
        (
            ConsultaId,
            FisioterapeutaId,
            PacienteId,
            DataHora,
            StatusConsulta,
            TransacaoId,
            StatusTransacao,
            ValorTotal,
            ValorPrevisto,
            ValorRealizado
        )
        SELECT
            v.ConsultaId,
            v.FisioterapeutaId,
            v.PacienteId,
            v.DataHora,
            v.StatusConsulta,
            v.TransacaoId,
            v.StatusTransacao,
            v.ValorTotal,
            v.ValorPrevisto,
            v.ValorRealizado
        FROM analytics.vw_PipelineFinanceiro_Fonte v;

        SET @Inseridas = @@ROWCOUNT;

        SELECT @LinhasDepois = COUNT_BIG(1) FROM cache.PipelineFinanceiro;

        COMMIT;

        /* =========================
           5) Log sucesso
        ========================= */
        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

        SET @Mensagem =
            N'Cache atualizado com sucesso: cache.PipelineFinanceiro'
            + N' | LinhasAntes=' + CAST(@LinhasAntes AS NVARCHAR(40))
            + N' | RowsFonte='   + CAST(@RowsFonte   AS NVARCHAR(40))
            + N' | Inseridas='   + CAST(@Inseridas   AS NVARCHAR(40))
            + N' | LinhasDepois='+ CAST(@LinhasDepois AS NVARCHAR(40))
            + N' | FonteMaxDataHora=' + ISNULL(CONVERT(NVARCHAR(30), @FonteMaxDataHora, 121), N'NULL')
            + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
            + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
            + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
            + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'PipelineFinanceiro', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarPipelineFinanceiro', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

        EXEC sp_releaseapplock @Resource = N'cache.PipelineFinanceiro', @LockOwner = N'Session';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);
        SET @Status = N'Falha';

        SET @Mensagem =
            N'Falha ao atualizar cache.PipelineFinanceiro'
            + N' | Erro=' + ERROR_MESSAGE()
            + N' | Linha=' + CAST(ERROR_LINE() AS NVARCHAR(10))
            + N' | Proc=' + ISNULL(ERROR_PROCEDURE(), N'?');

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'PipelineFinanceiro', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarPipelineFinanceiro', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

        IF (@HasLock = 1)
            EXEC sp_releaseapplock @Resource = N'cache.PipelineFinanceiro', @LockOwner = N'Session';

        THROW;
    END CATCH
END;
GO
/****** Object:  StoredProcedure [dbo].[SP_AtualizarRetencaoPacientes]    Script Date: 22/06/2026 09:39:11 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

-- ----------------------------------------------------------------
-- 4) Stored Procedure com INSERT atualizado para DtUltimaConsulta
--    Única alteração em relação ao SP original: bloco "4) Atualiza cache"
--    agora inclui DtUltimaConsulta na lista de colunas e no SELECT.
-- ----------------------------------------------------------------
CREATE OR ALTER PROCEDURE [dbo].[SP_AtualizarRetencaoPacientes]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @Inicio DATETIME2(3) = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))),
        @Fim DATETIME2(3),
        @DuracaoSegundos INT,

        @RowsFonte BIGINT = 0,
        @LinhasAntes BIGINT = 0,
        @Inseridas BIGINT = 0,
        @LinhasDepois BIGINT = 0,

        @Mensagem NVARCHAR(4000) = N'',
        @Status NVARCHAR(20) = N'Sucesso',

        @UsuarioExecucao NVARCHAR(200) = SUSER_SNAME(),
        @OriginalLogin   NVARCHAR(200) = ORIGINAL_LOGIN(),
        @Servidor        NVARCHAR(200) = HOST_NAME(),

        @CtxTipo NVARCHAR(40),
        @CtxId INT,
        @AdminId INT,
        @ReadOnly BIT = 0,

        @lockResult INT,
        @HasLock BIT = 0,
        @Tentativas INT = 0,
        @MaxTentativas INT = 60,

        @FonteMaxDataHora DATETIME = NULL;

    BEGIN TRY
        /* =========================
              1) AppLock com retry
           ========================= */
        WHILE (@Tentativas < @MaxTentativas)
        BEGIN
            EXEC @lockResult = sp_getapplock
                @Resource    = N'cache.RetencaoPacientes',
                @LockMode    = N'Exclusive',
                @LockOwner   = N'Session',
                @LockTimeout = 0;

            IF (@lockResult >= 0)
            BEGIN
                SET @HasLock = 1;
                BREAK;
            END

            SET @Tentativas += 1;
            WAITFOR DELAY '00:00:05';
        END

        IF (@HasLock = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Execução pulada: não foi possível obter AppLock (provável concorrência ou sessão antiga segurando lock).'
                + N' | Tentativas=' + CAST(@MaxTentativas AS NVARCHAR(10))
                + N' | Usuario=' + ISNULL(@UsuarioExecucao, N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin, N'?');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'RetencaoPacientes', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarRetencaoPacientes', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            RETURN;
        END

        /* =========================
              2) Contexto Admin (bypass RLS)
           ========================= */
        SELECT
            @CtxTipo = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)),
            @CtxId   = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));

        SELECT TOP (1) @AdminId = Id
        FROM dbo.Administradores
        WHERE Ativo = 1
        ORDER BY Id;

        IF @AdminId IS NULL
            THROW 51001, 'Nenhum Administrador Ativo encontrado para setar contexto Admin.', 1;

        IF (@UsuarioExecucao = N'NT SERVICE\SQLSERVERAGENT' OR PROGRAM_NAME() LIKE N'SQLAgent%')
            SET @ReadOnly = 1;

        IF (@CtxTipo IS NULL)
        BEGIN
            EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin', @read_only = @ReadOnly;
            EXEC sys.sp_set_session_context @key = N'UsuarioId',   @value = @AdminId,  @read_only = @ReadOnly;
        END

        /* =========================
              3) Fonte
           ========================= */
        SELECT @RowsFonte = COUNT_BIG(1)
        FROM analytics.vw_RetencaoPacientes_Fonte;

        SELECT @FonteMaxDataHora = MAX(c.DataHora)
        FROM dbo.Consultas c
        WHERE c.DataHora IS NOT NULL
          AND UPPER(LTRIM(RTRIM(ISNULL(c.Status, N'')))) COLLATE Latin1_General_CI_AI = N'CONCLUIDA';

        IF (@RowsFonte = 0)
        BEGIN
            SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
            SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

            SET @Mensagem =
                N'Fonte retornou 0 linhas (cache preservado).'
                + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
                + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
                + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
                + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

            INSERT INTO cache.LogAtualizacaoCache
                (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
            VALUES
                (N'RetencaoPacientes', N'Sucesso', @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarRetencaoPacientes', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

            EXEC sp_releaseapplock @Resource = N'cache.RetencaoPacientes', @LockOwner = N'Session';
            RETURN;
        END

        /* =========================
              4) Atualiza cache
           ========================= */
        BEGIN TRAN;

        SELECT @LinhasAntes = COUNT_BIG(1) FROM cache.RetencaoPacientes;

        TRUNCATE TABLE cache.RetencaoPacientes;

        -- ► ÚNICA ALTERAÇÃO EM RELAÇÃO AO SP ORIGINAL:
        --   DtUltimaConsulta adicionado na lista de colunas e no SELECT
        INSERT INTO cache.RetencaoPacientes
            (PacienteId, Nome, TotalConsultas, IntervaloDias, DtUltimaConsulta, PacienteRetido)
        SELECT
            PacienteId, Nome, TotalConsultas, IntervaloDias, DtUltimaConsulta, PacienteRetido
        FROM analytics.vw_RetencaoPacientes_Fonte;

        SET @Inseridas = @@ROWCOUNT;

        SELECT @LinhasDepois = COUNT_BIG(1) FROM cache.RetencaoPacientes;

        COMMIT;

        /* =========================
              5) Log sucesso
           ========================= */
        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);

        SET @Mensagem =
            N'Cache atualizado com sucesso: cache.RetencaoPacientes'
            + N' | LinhasAntes=' + CAST(@LinhasAntes AS NVARCHAR(40))
            + N' | RowsFonte='   + CAST(@RowsFonte   AS NVARCHAR(40))
            + N' | Inseridas='   + CAST(@Inseridas   AS NVARCHAR(40))
            + N' | LinhasDepois='+ CAST(@LinhasDepois AS NVARCHAR(40))
            + N' | FonteMaxDataHora=' + ISNULL(CONVERT(NVARCHAR(30), @FonteMaxDataHora, 121), N'NULL')
            + N' | Usuario=' + ISNULL(@UsuarioExecucao,N'?')
            + N' | OriginalLogin=' + ISNULL(@OriginalLogin,N'?')
            + N' | CtxTipo=' + ISNULL(CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)), N'NULL')
            + N' | CtxId=' + ISNULL(CAST(TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId')) AS NVARCHAR(40)), N'NULL');

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'RetencaoPacientes', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarRetencaoPacientes', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

        EXEC sp_releaseapplock @Resource = N'cache.RetencaoPacientes', @LockOwner = N'Session';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        SET @Fim = COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7)));
        SET @DuracaoSegundos = DATEDIFF(SECOND, @Inicio, @Fim);
        SET @Status = N'Falha';

        SET @Mensagem =
            N'Falha ao atualizar cache.RetencaoPacientes'
            + N' | Erro=' + ERROR_MESSAGE()
            + N' | Linha=' + CAST(ERROR_LINE() AS NVARCHAR(10))
            + N' | Proc=' + ISNULL(ERROR_PROCEDURE(), N'?');

        INSERT INTO cache.LogAtualizacaoCache
            (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao, DataAtualizacao)
        VALUES
            (N'RetencaoPacientes', @Status, @Mensagem, @DuracaoSegundos, @Fim, @Servidor, @UsuarioExecucao, N'dbo.SP_AtualizarRetencaoPacientes', COALESCE(@AgoraBrasil, CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))));

        IF (@HasLock = 1)
            EXEC sp_releaseapplock @Resource = N'cache.RetencaoPacientes', @LockOwner = N'Session';

        THROW;
    END CATCH
END
GO
SELECT
    CAST(1 AS BIT) AS Sucesso,
    N'AZURE_TIMEZONE_CACHE_JOBS_V120 aplicado. SPs de cache passam a usar horario Sao Paulo em Azure SQL.' AS Mensagem;
GO
