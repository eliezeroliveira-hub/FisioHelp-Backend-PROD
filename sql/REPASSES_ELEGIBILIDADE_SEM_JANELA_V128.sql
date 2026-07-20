SET XACT_ABORT ON;
GO

BEGIN TRY
  BEGIN TRAN;

  EXEC(N'
CREATE OR ALTER PROCEDURE [dbo].[SP_ProcessarRepassesSemanais]
    @HorasContestacao INT = 24,
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE ''UTC'' AT TIME ZONE ''E. South America Standard Time'' AS DATETIME2(7))
    );

    DECLARE @CtxTipo NVARCHAR(40) = CAST(SESSION_CONTEXT(N''UsuarioTipo'') AS NVARCHAR(40));
    DECLARE @CtxId INT = TRY_CONVERT(INT, SESSION_CONTEXT(N''UsuarioId''));
    DECLARE @AdminId INT;

    IF (@CtxTipo IS NULL OR @CtxTipo <> N''Admin'' OR @CtxId IS NULL)
    BEGIN
        SELECT TOP (1) @AdminId = Id FROM dbo.Administradores WHERE Ativo = 1 ORDER BY Id;
        IF @AdminId IS NOT NULL
        BEGIN
            EXEC sys.sp_set_session_context @key = N''UsuarioTipo'', @value = N''Admin'';
            EXEC sys.sp_set_session_context @key = N''UsuarioId'', @value = @AdminId;
        END
    END

    IF OBJECT_ID(''tempdb..#Calculo'') IS NOT NULL DROP TABLE #Calculo;
    IF OBJECT_ID(''tempdb..#OutputRepasses'') IS NOT NULL DROP TABLE #OutputRepasses;
    IF OBJECT_ID(''tempdb..#RepassesInseridos'') IS NOT NULL DROP TABLE #RepassesInseridos;

    CREATE TABLE #Calculo (
        TransacaoId INT NOT NULL PRIMARY KEY,
        FisioterapeutaId INT NOT NULL,
        ConsultaId INT NOT NULL,
        ValorTotal DECIMAL(10,2) NOT NULL,
        ValorBase DECIMAL(10,2) NOT NULL,
        ValorRepasseBase DECIMAL(10,2) NOT NULL,
        ValorLiquido DECIMAL(10,2) NOT NULL
    );

    CREATE TABLE #OutputRepasses (
        RepasseId INT NOT NULL PRIMARY KEY,
        FisioterapeutaId INT NOT NULL,
        TransacaoId INT NOT NULL,
        ValorLiquido DECIMAL(10,2) NOT NULL
    );

    CREATE TABLE #RepassesInseridos (
        RepasseId INT NOT NULL PRIMARY KEY,
        FisioterapeutaId INT NOT NULL,
        TransacaoId INT NOT NULL,
        ConsultaId INT NOT NULL,
        ValorBruto DECIMAL(10,2) NOT NULL,
        ValorBase DECIMAL(10,2) NOT NULL,
        ValorLiquido DECIMAL(10,2) NOT NULL
    );

    BEGIN TRY
        BEGIN TRAN;

        ;WITH Elegiveis AS (
            SELECT
                t.Id AS TransacaoId,
                t.FisioterapeutaId,
                t.ValorTotal,
                t.DataConfirmacao,
                t.DataCriacao,
                LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N''''))) AS MetodoPagamento,
                c.Id AS ConsultaId,
                c.DataHora,
                ISNULL(c.IsentoTaxaServico, 0) AS IsentoTaxaServico,
                ISNULL(c.IsentoIntermediacao, 0) AS IsentoIntermediacao,
                cp.PacoteId AS PacoteIdCredito,
                p.DataCompra AS DataCompraPacote,
                LTRIM(RTRIM(ISNULL(c.Status, N''''))) AS StatusConsulta,
                ISNULL(c.ConfirmacaoAtendimento, 0) AS ConfirmacaoAtendimento,
                c.CheckinHora
            FROM dbo.Transacoes t
            INNER JOIN dbo.Consultas c ON c.Id = t.ConsultaId
            OUTER APPLY (
                SELECT TOP (1) cp.PacoteId
                FROM dbo.CreditosPacientes cp WITH (READCOMMITTEDLOCK)
                WHERE cp.ConsultaId = c.Id
                  AND cp.PacienteId = c.PacienteId
                  AND cp.PacoteId IS NOT NULL
                ORDER BY cp.UsadoEm DESC, cp.Id DESC
            ) cp
            LEFT JOIN dbo.Pacotes p ON p.Id = cp.PacoteId
            WHERE
                LTRIM(RTRIM(ISNULL(t.Status, N''''))) = N''Pago''
                AND ISNULL(c.PagamentoViaPlataforma, 0) = 1
                AND LTRIM(RTRIM(ISNULL(c.OrigemPagamento, N''''))) = N''Plataforma''
                AND LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''''))) <> N''Reembolsado''
                AND (
                    (
                        LTRIM(RTRIM(ISNULL(c.Status, N''''))) = N''Concluída''
                        AND ISNULL(c.ConfirmacaoAtendimento, 0) = 1
                    )
                    OR (
                        LTRIM(RTRIM(ISNULL(c.Status, N''''))) = N''Paciente Ausente''
                        AND ISNULL(c.ConfirmacaoAtendimento, 0) = 0
                        AND c.CheckinHora IS NOT NULL
                        AND DATEDIFF(HOUR, c.CheckinHora, @Agora) >= @HorasContestacao
                        AND NOT EXISTS (
                            SELECT 1 FROM dbo.DisputasConsultas d
                            WHERE d.ConsultaId = c.Id
                              AND LTRIM(RTRIM(ISNULL(d.Status, N'''')))
                                  IN (N''Aberta'', N''EmAnalise'', N''ProcedentePaciente'')
                        )
                    )
                )
        ),
        Base AS (
            SELECT
                e.TransacaoId,
                e.FisioterapeutaId,
                e.ConsultaId,
                ValorTotal = CAST(e.ValorTotal AS DECIMAL(10,2)),
                ValorBase = CAST(COALESCE(fd.ValorBase, decv.ValorBase) AS DECIMAL(10,2)),
                ValorRepasseBase = CAST(COALESCE(fd.ValorRepasseFisio, decv.ValorRepasseFisio) AS DECIMAL(10,2))
            FROM Elegiveis e
            OUTER APPLY (
                SELECT TOP (1) fd.*
                FROM dbo.FinanceiroDecomposicoes fd
                WHERE fd.ConsultaId = e.ConsultaId
                  AND fd.OrigemCalculo = N''Sistema''
                ORDER BY CASE fd.TipoOrigem WHEN N''Consulta'' THEN 1 WHEN N''ConsultaPacote'' THEN 2 WHEN N''CreditoCarteira'' THEN 3 ELSE 4 END,
                         fd.Id DESC
            ) fd
            CROSS APPLY dbo.fn_DecomporValorPacienteV2(
                CAST(e.ValorTotal AS DECIMAL(18,2)),
                CASE WHEN e.MetodoPagamento = N''Pacote'' THEN N''Pacote'' ELSE N''ConsultaAvulsa'' END,
                CASE WHEN e.MetodoPagamento = N''Pacote'' THEN 10 ELSE 1 END,
                CAST(COALESCE(e.DataCompraPacote, e.DataHora, e.DataConfirmacao, e.DataCriacao) AS DATE),
                e.IsentoTaxaServico,
                e.IsentoIntermediacao
            ) decv
            WHERE NOT EXISTS (SELECT 1 FROM dbo.Repasses r WHERE r.TransacaoId = e.TransacaoId)
        )
        INSERT INTO #Calculo (TransacaoId, FisioterapeutaId, ConsultaId,
                              ValorTotal, ValorBase, ValorRepasseBase, ValorLiquido)
        SELECT TransacaoId, FisioterapeutaId, ConsultaId,
               ValorTotal, ValorBase, ValorRepasseBase,
               ValorRepasseBase
        FROM Base;

        IF NOT EXISTS (SELECT 1 FROM #Calculo)
        BEGIN
            COMMIT;
            SELECT CAST(1 AS BIT) AS Sucesso, 0 AS RepassesCriados,
                   CAST(0 AS DECIMAL(10,2)) AS TotalBruto,
                   CAST(0 AS DECIMAL(10,2)) AS TotalBase,
                   CAST(0 AS DECIMAL(10,2)) AS TotalLiquido;
            RETURN;
        END

        INSERT INTO dbo.Repasses (FisioterapeutaId, TransacaoId, ValorLiquido, DataPrevista, Status)
        OUTPUT inserted.Id, inserted.FisioterapeutaId, inserted.TransacaoId, inserted.ValorLiquido
        INTO #OutputRepasses (RepasseId, FisioterapeutaId, TransacaoId, ValorLiquido)
        SELECT c.FisioterapeutaId, c.TransacaoId, c.ValorLiquido,
               DATEADD(HOUR, 10, CAST(DATEADD(DAY, 1, CAST(@Agora AS DATE)) AS DATETIME2(7))),
               N''Pendente''
        FROM #Calculo c
        WHERE NOT EXISTS (
            SELECT 1 FROM dbo.Repasses r WITH (UPDLOCK, HOLDLOCK)
            WHERE r.TransacaoId = c.TransacaoId
        );

        INSERT INTO #RepassesInseridos
            (RepasseId, FisioterapeutaId, TransacaoId, ConsultaId,
             ValorBruto, ValorBase, ValorLiquido)
        SELECT o.RepasseId, o.FisioterapeutaId, o.TransacaoId, c.ConsultaId,
               c.ValorTotal, c.ValorBase, o.ValorLiquido
        FROM #OutputRepasses o
        JOIN #Calculo c ON c.TransacaoId = o.TransacaoId;

        COMMIT;

        SELECT
            CAST(1 AS BIT) AS Sucesso,
            COUNT(*) AS RepassesCriados,
            ISNULL(SUM(ValorBruto), 0) AS TotalBruto,
            ISNULL(SUM(ValorBase), 0) AS TotalBase,
            ISNULL(SUM(ValorLiquido), 0) AS TotalLiquido
        FROM #RepassesInseridos;

    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
        RAISERROR(@Err, 16, 1);
    END CATCH
END;
');

  IF EXISTS (
      SELECT 1
      FROM sys.parameters
      WHERE object_id = OBJECT_ID(N'dbo.SP_ProcessarRepassesSemanais', N'P')
        AND name IN (N'@DataInicio', N'@DataFim')
  )
      THROW 51280, 'Parametros legados de janela ainda presentes na SP.', 1;

  DECLARE @Definition NVARCHAR(MAX) = OBJECT_DEFINITION(OBJECT_ID(N'dbo.SP_ProcessarRepassesSemanais', N'P'));

  IF @Definition LIKE N'%t.DataCriacao >= @DataInicio%'
     OR @Definition LIKE N'%t.DataCriacao < DATEADD(DAY, 1, @DataFim)%'
      THROW 51281, 'Filtros legados por Transacoes.DataCriacao ainda presentes na SP.', 1;

  IF @Definition NOT LIKE N'%N''Concluída''%'
     OR @Definition NOT LIKE N'%N''Paciente Ausente''%'
     OR @Definition NOT LIKE N'%WITH (UPDLOCK, HOLDLOCK)%'
      THROW 51282, 'Invariantes dos fluxos de repasse nao foram preservadas.', 1;

  COMMIT;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  THROW;
END CATCH;
GO

SELECT
  CAST(1 AS BIT) AS Sucesso,
  N'REPASSES_ELEGIBILIDADE_SEM_JANELA_V128 aplicado. Repasses elegiveis deixam de depender de Transacoes.DataCriacao.' AS Mensagem;
GO
