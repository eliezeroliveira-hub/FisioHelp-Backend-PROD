SET XACT_ABORT ON;
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_AtualizarAlertasReincidencia]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );

    ;WITH Tentativas AS (
        SELECT
            c.RemetenteId AS UsuarioId,
            MAX(c.CriadoEm) AS UltimaTentativa,
            COUNT(*) AS TotalTentativas,
            STRING_AGG(LEFT(c.Motivo, 200), '; ') AS Motivos
        FROM dbo.ChatModerationLogs AS c
        WHERE c.Acao = N'BLOQUEADA'
          AND c.CriadoEm > DATEADD(DAY, -7, @Agora)
        GROUP BY c.RemetenteId
    )
    MERGE dbo.ChatModerationAlertLogs AS tgt
    USING Tentativas AS src
        ON tgt.UsuarioId = src.UsuarioId
    WHEN MATCHED THEN
        UPDATE SET
            tgt.TotalBloqueios = tgt.TotalBloqueios + src.TotalTentativas,
            tgt.UltimaTentativa = src.UltimaTentativa,
            tgt.Motivos = CONCAT(ISNULL(tgt.Motivos, ''), '; ', src.Motivos)
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (UsuarioId, TipoUsuario, NomeUsuario, TotalBloqueios, UltimaTentativa, Motivos, CriadoEm)
        VALUES (
            src.UsuarioId,
            N'Desconhecido',
            NULL,
            src.TotalTentativas,
            src.UltimaTentativa,
            src.Motivos,
            @Agora
        );
END;
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_LimparLogsChat]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );

    DECLARE @DataLimite DATETIME2(7) = DATEADD(DAY, -90, @Agora);

    DELETE FROM dbo.ChatModerationLogs
    WHERE CriadoEm < @DataLimite;

    DELETE FROM dbo.ChatModerationAlertLogs
    WHERE UltimaTentativa < @DataLimite;
END;
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_LimparLogsRanking]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );

    DELETE FROM dbo.RankingUpdateLogs
    WHERE ExecutadoEm < DATEADD(DAY, -90, @Agora);
END;
GO

SELECT
    CAST(1 AS BIT) AS Sucesso,
    N'AZURE_TIMEZONE_PURGE_JOBS_V119 aplicado. SPs de purge passam a aceitar @AgoraBrasil/fallback Sao Paulo.' AS Mensagem;
GO
