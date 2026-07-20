SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

BEGIN TRY
    BEGIN TRAN;

    DECLARE @ProcedureName SYSNAME = N'dbo.SP_ProcessarRepassesSemanais';
    DECLARE @ProcedureId INT = OBJECT_ID(@ProcedureName, N'P');
    DECLARE @Definition NVARCHAR(MAX);
    DECLARE @InvalidDateExpression NVARCHAR(4000) =
        N'DATEADD(HOUR, 10, DATEADD(DAY, 1, CAST(@Agora AS DATE)))';
    DECLARE @SevenDaysExpression NVARCHAR(4000) =
        N'DATEADD(DAY, 7, CAST(@Agora AS DATE))';
    DECLARE @NewExpression NVARCHAR(4000) =
        N'DATEADD(HOUR, 10, CAST(DATEADD(DAY, 1, CAST(@Agora AS DATE)) AS DATETIME2(7)))';
    DECLARE @InvalidDateOccurrences INT;
    DECLARE @SevenDaysOccurrences INT;
    DECLARE @NewOccurrences INT;
    DECLARE @CreatePosition INT;

    IF @ProcedureId IS NULL
        THROW 51000, 'dbo.SP_ProcessarRepassesSemanais nao foi encontrada.', 1;

    SET @Definition = OBJECT_DEFINITION(@ProcedureId);

    IF @Definition IS NULL
        THROW 51001, 'Nao foi possivel ler a definicao da procedure.', 1;

    SET @InvalidDateOccurrences =
        (LEN(@Definition) - LEN(REPLACE(@Definition, @InvalidDateExpression, N'')))
        / NULLIF(LEN(@InvalidDateExpression), 0);
    SET @SevenDaysOccurrences =
        (LEN(@Definition) - LEN(REPLACE(@Definition, @SevenDaysExpression, N'')))
        / NULLIF(LEN(@SevenDaysExpression), 0);
    SET @NewOccurrences =
        (LEN(@Definition) - LEN(REPLACE(@Definition, @NewExpression, N'')))
        / NULLIF(LEN(@NewExpression), 0);

    IF @NewOccurrences = 1
       AND @InvalidDateOccurrences = 0
       AND @SevenDaysOccurrences = 0
    BEGIN
        COMMIT;
        GOTO HotfixConcluido;
    END

    IF @NewOccurrences <> 0
       OR (@InvalidDateOccurrences + @SevenDaysOccurrences) <> 1
        THROW 51002, 'Migration abortada: estado da expressao DataPrevista nao reconhecido.', 1;

    SET @Definition = REPLACE(@Definition, @InvalidDateExpression, @NewExpression);
    SET @Definition = REPLACE(@Definition, @SevenDaysExpression, @NewExpression);
    SET @CreatePosition = CHARINDEX(N'CREATE PROCEDURE', UPPER(@Definition));

    IF @CreatePosition > 0
    BEGIN
        SET @Definition = STUFF(
            @Definition,
            @CreatePosition,
            LEN(N'CREATE PROCEDURE'),
            N'ALTER PROCEDURE'
        );
    END
    ELSE IF CHARINDEX(N'ALTER PROCEDURE', UPPER(@Definition)) = 0
        THROW 51003, 'Migration abortada: cabecalho CREATE/ALTER PROCEDURE nao reconhecido.', 1;

    EXEC sys.sp_executesql @Definition;

    IF OBJECT_DEFINITION(@ProcedureId) LIKE N'%' + @InvalidDateExpression + N'%'
       OR OBJECT_DEFINITION(@ProcedureId) LIKE N'%' + @SevenDaysExpression + N'%'
        THROW 51004, 'Validacao falhou: uma expressao antiga continua presente.', 1;

    IF OBJECT_DEFINITION(@ProcedureId) NOT LIKE N'%' + @NewExpression + N'%'
        THROW 51005, 'Validacao falhou: a expressao corrigida nao foi encontrada.', 1;

    COMMIT;

HotfixConcluido:
    ;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    THROW;
END CATCH;
GO

SELECT
    OBJECT_SCHEMA_NAME(p.object_id) AS SchemaName,
    p.name AS ProcedureName,
    CASE
        WHEN OBJECT_DEFINITION(p.object_id) LIKE
             N'%DATEADD(HOUR, 10, CAST(DATEADD(DAY, 1, CAST(@Agora AS DATE)) AS DATETIME2(7)))%'
            THEN N'CORRIGIDA'
        ELSE N'NAO CORRIGIDA'
    END AS StatusHotfix
FROM sys.procedures p
WHERE p.object_id = OBJECT_ID(N'dbo.SP_ProcessarRepassesSemanais', N'P');
GO
