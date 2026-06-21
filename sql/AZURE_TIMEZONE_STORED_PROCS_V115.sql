-- AZURE_TIMEZONE_STORED_PROCS_V115.sql
-- Forward-only: ajusta stored procedures sensiveis para nao dependerem do timezone do motor SQL.
-- Convencao: datas de negocio continuam como DATETIME/DATETIME2 naive em horario de Sao Paulo.
-- @AgoraBrasil e opcional para compatibilidade; quando ausente, a SP calcula horario de Sao Paulo no proprio SQL.
/****** Object:  StoredProcedure [dbo].[SP_Financeiro_RegistrarDecomposicao]    Script Date: 19/06/2026 20:18:05 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

/* ============================================================
   1) SP de snapshot com modo silencioso
   ============================================================ */
CREATE OR ALTER PROCEDURE [dbo].[SP_Financeiro_RegistrarDecomposicao]
    @TipoOrigem NVARCHAR(30),
    @OrigemId INT,
    @ValorCobradoPaciente DECIMAL(18,2),
    @ContextoCalculo NVARCHAR(30),
    @Parcelas TINYINT = 1,
    @DataReferencia DATE = NULL,
    @ConsultaId INT = NULL,
    @PacoteId INT = NULL,
    @TransacaoId INT = NULL,
    @CreditoPacienteId INT = NULL,
    @IsentoTaxaServico BIT = 0,
    @IsentoIntermediacao BIT = 0,
    @OrigemCalculo NVARCHAR(30) = N'Sistema',
    @CriadoPor NVARCHAR(100) = NULL,
    @Observacao NVARCHAR(500) = NULL,
    @Silencioso BIT = 0,
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );

    IF @TipoOrigem NOT IN (N'Consulta', N'Pacote', N'ConsultaPacote', N'CreditoCarteira')
        THROW 51050, N'TipoOrigem invalido.', 1;

    IF @ContextoCalculo NOT IN (N'ConsultaAvulsa', N'Pacote', N'ConsultaPacote', N'CreditoCarteira')
        THROW 51051, N'ContextoCalculo invalido.', 1;

    IF @OrigemId IS NULL OR @OrigemId <= 0
        THROW 51052, N'OrigemId invalido.', 1;

    IF @ValorCobradoPaciente IS NULL OR @ValorCobradoPaciente < 0
        THROW 51053, N'ValorCobradoPaciente invalido.', 1;

    IF @Parcelas IS NULL OR @Parcelas < 1
        SET @Parcelas = 1;

    IF @DataReferencia IS NULL
        SET @DataReferencia = CAST(@Agora AS DATE);

    IF EXISTS (
        SELECT 1
        FROM dbo.FinanceiroDecomposicoes WITH (UPDLOCK, HOLDLOCK)
        WHERE TipoOrigem = @TipoOrigem
          AND OrigemId = @OrigemId
          AND OrigemCalculo = @OrigemCalculo
    )
    BEGIN
        IF ISNULL(@Silencioso, 0) = 0
        BEGIN
            SELECT TOP (1) *
            FROM dbo.vw_FinanceiroDecomposicoes
            WHERE TipoOrigem = @TipoOrigem
              AND OrigemId = @OrigemId
              AND OrigemCalculo = @OrigemCalculo
            ORDER BY Id DESC;
        END
        RETURN;
    END;

    DECLARE @ContextoGateway NVARCHAR(30) =
        CASE
            WHEN @ContextoCalculo IN (N'ConsultaPacote', N'CreditoCarteira') THEN NULL
            ELSE @ContextoCalculo
        END;

    DECLARE @Calc TABLE
    (
        ValorFinalPaciente DECIMAL(18,2),
        ContextoCalculo NVARCHAR(30),
        Parcelas TINYINT,
        GatewayPerfilCustoId INT NULL,
        TaxaGatewayPrecificacao DECIMAL(10,4),
        TaxaGatewayRealPercentual DECIMAL(10,4),
        TaxaGatewayAntecipacaoMensal DECIMAL(10,4) NULL,
        TaxaServico DECIMAL(10,4),
        TaxaIntermediacao DECIMAL(10,4),
        PrazoDias SMALLINT NULL,
        FixoPor NVARCHAR(20) NULL,
        ValorBase DECIMAL(18,2),
        ValorGatewayPercentual DECIMAL(18,2),
        ValorGatewayFixo DECIMAL(18,2),
        ValorGatewayAntecipacao DECIMAL(18,2),
        ValorLiquidoGateway DECIMAL(18,2),
        ValorServicoPlataforma DECIMAL(18,2),
        ValorIntermediacao DECIMAL(18,2),
        ValorRepasseFisio DECIMAL(18,2),
        ReceitaContratualPlataforma DECIMAL(18,2),
        ResultadoPosGatewayPlataforma DECIMAL(18,2),
        GapGateway DECIMAL(18,2)
    );

    IF @ContextoGateway IS NULL
    BEGIN
        INSERT INTO @Calc
        SELECT
            ValorFinalPaciente = @ValorCobradoPaciente,
            ContextoCalculo = @ContextoCalculo,
            Parcelas = @Parcelas,
            GatewayPerfilCustoId = NULL,
            TaxaGatewayPrecificacao = CAST(dbo.fn_TaxaPercentual(N'Gateway', @DataReferencia) AS DECIMAL(10,4)),
            TaxaGatewayRealPercentual = CAST(0 AS DECIMAL(10,4)),
            TaxaGatewayAntecipacaoMensal = CAST(NULL AS DECIMAL(10,4)),
            TaxaServico = CAST(CASE WHEN @IsentoTaxaServico = 1 THEN 0 ELSE dbo.fn_TaxaPercentual(N'Plataforma', @DataReferencia) END AS DECIMAL(10,4)),
            TaxaIntermediacao = CAST(CASE WHEN @IsentoIntermediacao = 1 THEN 0 ELSE dbo.fn_TaxaPercentual(N'Intermediacao', @DataReferencia) END AS DECIMAL(10,4)),
            PrazoDias = NULL,
            FixoPor = NULL,
            ValorBase = v.ValorBaseFisio,
            ValorGatewayPercentual = 0,
            ValorGatewayFixo = 0,
            ValorGatewayAntecipacao = 0,
            ValorLiquidoGateway = @ValorCobradoPaciente,
            ValorServicoPlataforma = v.ValorServicoPlataforma,
            ValorIntermediacao = v.ValorIntermediacao,
            ValorRepasseFisio = v.ValorLiquidoFisio,
            ReceitaContratualPlataforma = v.ReceitaContratualPlataforma,
            ResultadoPosGatewayPlataforma = CAST(ROUND(@ValorCobradoPaciente - v.ValorLiquidoFisio, 2) AS DECIMAL(18,2)),
            GapGateway = CAST(ROUND(v.ReceitaContratualPlataforma - (@ValorCobradoPaciente - v.ValorLiquidoFisio), 2) AS DECIMAL(18,2))
        FROM dbo.fn_ValorConsultaFinalV2(
            CAST(
                CASE
                    WHEN @ValorCobradoPaciente <= 0 THEN 0
                    ELSE
                        (@ValorCobradoPaciente * (1 - (dbo.fn_TaxaPercentual(N'Gateway', @DataReferencia) / 100.0)))
                        / NULLIF(1 + ((CASE WHEN @IsentoTaxaServico = 1 THEN 0 ELSE dbo.fn_TaxaPercentual(N'Plataforma', @DataReferencia) END) / 100.0), 0)
                END
            AS DECIMAL(18,2)),
            @DataReferencia,
            @IsentoTaxaServico,
            @IsentoIntermediacao
        ) v;
    END
    ELSE
    BEGIN
        INSERT INTO @Calc
        SELECT
            ValorFinalPaciente,
            ContextoCalculo,
            Parcelas,
            GatewayPerfilCustoId,
            TaxaGatewayPrecificacao,
            TaxaGatewayRealPercentual,
            TaxaGatewayAntecipacaoMensal,
            TaxaServico,
            TaxaIntermediacao,
            PrazoDias,
            FixoPor,
            ValorBase,
            ValorGatewayPercentual,
            ValorGatewayFixo,
            ValorGatewayAntecipacao,
            ValorLiquidoGateway,
            ValorServicoPlataforma,
            ValorIntermediacao,
            ValorRepasseFisio,
            ReceitaContratualPlataforma,
            ResultadoPosGatewayPlataforma,
            GapGateway
        FROM dbo.fn_DecomporValorPacienteV2(
            @ValorCobradoPaciente,
            @ContextoGateway,
            @Parcelas,
            @DataReferencia,
            @IsentoTaxaServico,
            @IsentoIntermediacao
        );
    END;

    INSERT INTO dbo.FinanceiroDecomposicoes
    (
        TipoOrigem, OrigemId, ConsultaId, PacoteId, TransacaoId, CreditoPacienteId,
        GatewayPerfilCustoId, Parcelas, ContextoCalculo,
        TaxaIntermediacao, TaxaServico, TaxaGatewayPrecificacao,
        TaxaGatewayRealPercentual, TaxaGatewayAntecipacaoMensal, PrazoDias, FixoPor,
        ValorBase, ValorCobradoPaciente, ValorGatewayPercentual, ValorGatewayFixo,
        ValorGatewayAntecipacao, ValorLiquidoGateway, ValorIntermediacao,
        ValorServicoPlataforma, ValorRepasseFisio, ReceitaContratualPlataforma,
        ResultadoPosGatewayPlataforma, GapGateway,
        DataReferencia, OrigemCalculo, CriadoPor, Observacao
    )
    SELECT
        @TipoOrigem, @OrigemId, @ConsultaId, @PacoteId, @TransacaoId, @CreditoPacienteId,
        GatewayPerfilCustoId, Parcelas, @ContextoCalculo,
        TaxaIntermediacao, TaxaServico, TaxaGatewayPrecificacao,
        TaxaGatewayRealPercentual, TaxaGatewayAntecipacaoMensal, PrazoDias, FixoPor,
        ValorBase, @ValorCobradoPaciente, ValorGatewayPercentual, ValorGatewayFixo,
        ValorGatewayAntecipacao, ValorLiquidoGateway, ValorIntermediacao,
        ValorServicoPlataforma, ValorRepasseFisio, ReceitaContratualPlataforma,
        ResultadoPosGatewayPlataforma, GapGateway,
        @DataReferencia, @OrigemCalculo, @CriadoPor, @Observacao
    FROM @Calc;

    IF ISNULL(@Silencioso, 0) = 0
    BEGIN
        SELECT *
        FROM dbo.vw_FinanceiroDecomposicoes
        WHERE Id = CONVERT(INT, SCOPE_IDENTITY());
    END
END;

GO

/****** Object:  StoredProcedure [dbo].[SP_ConfirmarConsulta]    Script Date: 19/06/2026 20:18:05 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE OR ALTER PROCEDURE [dbo].[SP_ConfirmarConsulta]
    @ConsultaId INT,
    @FisioterapeutaId INT,
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );

    BEGIN TRY
        BEGIN TRAN;

        DECLARE
            @Status NVARCHAR(60),
            @StatusPagamento NVARCHAR(100);

        -- 1) Existe e pertence ao fisio? + captura status atual
        SELECT
            @Status = LTRIM(RTRIM(ISNULL(c.Status, N''))),
            @StatusPagamento = LTRIM(RTRIM(ISNULL(c.StatusPagamento, N'')))
        FROM dbo.Consultas c
        WHERE c.Id = @ConsultaId
          AND c.FisioterapeutaId = @FisioterapeutaId;

        IF @Status IS NULL
        BEGIN
            RAISERROR(N'Consulta não encontrada para este fisioterapeuta.', 16, 1);
            ROLLBACK;
            RETURN;
        END

        -- 2) Defesa: não permite “reverter” status final (inclui Paciente Ausente)
        IF @Status IN (N'Cancelada', N'Concluída', N'Paciente Ausente')
        BEGIN
            RAISERROR(N'Consulta não pode ser confirmada pois está em status final (%s).', 16, 1, @Status);
            ROLLBACK;
            RETURN;
        END

        -- 3) Só confirma se estiver pago (Plataforma OU ForaPlataforma continuam como "Pago")
        IF @StatusPagamento <> N'Pago'
        BEGIN
            RAISERROR(N'Consulta não está paga (StatusPagamento <> Pago).', 16, 1);
            ROLLBACK;
            RETURN;
        END

        -- 4) Flag atual do fisio define ConfirmadaPor
        DECLARE @Auto BIT = 0;
        SELECT @Auto = ISNULL(ConfirmacaoAutomatica, 0)
        FROM dbo.Fisioterapeutas
        WHERE Id = @FisioterapeutaId;

        -- 5) Confirma (triggers continuam cuidando do ChatsAtivos)
        UPDATE dbo.Consultas
        SET
            Status = N'Confirmada',
            ConfirmadaEm = ISNULL(ConfirmadaEm, @Agora),
            ConfirmadaPor = ISNULL(ConfirmadaPor, CASE WHEN @Auto = 1 THEN N'Automática' ELSE N'Fisioterapeuta' END),
            ChatLiberado = 1,
            ChatLiberadoEm = ISNULL(ChatLiberadoEm, @Agora)
        WHERE Id = @ConsultaId
          AND FisioterapeutaId = @FisioterapeutaId
          AND (
                LTRIM(RTRIM(ISNULL(Status, N''))) IN (N'Aguardando', N'AguardandoConfirmação', N'AguardandoConfirmacao')
                OR (LTRIM(RTRIM(ISNULL(Status, N''))) = N'Confirmada' AND ISNULL(ChatLiberado, 0) = 0)
              );

        IF @@ROWCOUNT = 0
        BEGIN
            RAISERROR(N'Consulta não estava em status confirmável ou já estava confirmada com chat liberado.', 16, 1);
            ROLLBACK;
            RETURN;
        END

        COMMIT;

        SELECT
            CAST(1 AS bit) AS Sucesso,
            N'✅ Consulta confirmada e chat liberado.' AS Mensagem,
            @ConsultaId AS ConsultaId,
            CASE WHEN @Auto = 1 THEN N'Automática' ELSE N'Fisioterapeuta' END AS ConfirmadaPor;

    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
        RAISERROR(@Err, 16, 1);
    END CATCH
END;
GO

/****** Object:  StoredProcedure [dbo].[SP_ConfirmarConsultaAposPagamento]    Script Date: 19/06/2026 20:18:05 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

/* ============================================================
   3) Consulta avulsa paga no gateway
   ============================================================ */
CREATE OR ALTER PROCEDURE [dbo].[SP_ConfirmarConsultaAposPagamento]
    @TransacaoId INT,
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );

    BEGIN TRY
        BEGIN TRAN;

        DECLARE
            @ConsultaId INT,
            @FisioId INT,
            @ValorTransacao DECIMAL(18,2),
            @DataReferencia DATE;

        SELECT
            @ConsultaId = t.ConsultaId,
            @FisioId = t.FisioterapeutaId,
            @ValorTransacao = CAST(ISNULL(t.ValorTotal, 0) AS DECIMAL(18,2)),
            @DataReferencia = CAST(COALESCE(t.DataConfirmacao, t.DataCriacao, @Agora) AS DATE)
        FROM dbo.Transacoes t
        WHERE t.Id = @TransacaoId
          AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago';

        IF @ConsultaId IS NULL
        BEGIN
            RAISERROR(N'Nenhuma transacao PAGA encontrada para o ID informado.', 16, 1);
            ROLLBACK;
            RETURN;
        END

        UPDATE c
        SET
            c.PagamentoViaPlataforma = 1,
            c.OrigemPagamento = N'Plataforma',
            c.StatusPagamento = CASE
                WHEN LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))) = N'CreditoPaciente'
                    THEN c.StatusPagamento
                ELSE N'Pago'
            END,
            c.Status = CASE
                WHEN LTRIM(RTRIM(ISNULL(c.Status, N''))) IN (N'Aguardando', N'AguardandoConfirmacao', N'AguardandoConfirmação')
                    THEN N'Aguardando'
                ELSE c.Status
            END,
            c.ConfirmadaPor = CASE
                WHEN LTRIM(RTRIM(ISNULL(c.Status, N''))) IN (N'Aguardando', N'AguardandoConfirmacao', N'AguardandoConfirmação')
                    THEN NULL
                ELSE c.ConfirmadaPor
            END,
            c.ConfirmadaEm = CASE
                WHEN LTRIM(RTRIM(ISNULL(c.Status, N''))) IN (N'Aguardando', N'AguardandoConfirmacao', N'AguardandoConfirmação')
                    THEN NULL
                ELSE c.ConfirmadaEm
            END,
            c.ChatLiberado = CASE
                WHEN LTRIM(RTRIM(ISNULL(c.Status, N''))) IN (N'Aguardando', N'AguardandoConfirmacao', N'AguardandoConfirmação')
                    THEN 0
                ELSE c.ChatLiberado
            END,
            c.ChatLiberadoEm = CASE
                WHEN LTRIM(RTRIM(ISNULL(c.Status, N''))) IN (N'Aguardando', N'AguardandoConfirmacao', N'AguardandoConfirmação')
                    THEN NULL
                ELSE c.ChatLiberadoEm
            END
        FROM dbo.Consultas c
        WHERE c.Id = @ConsultaId
          AND c.FisioterapeutaId = @FisioId;

        IF @@ROWCOUNT = 0
        BEGIN
            RAISERROR(N'Consulta nao encontrada para a transacao informada.', 16, 1);
            ROLLBACK;
            RETURN;
        END

        IF EXISTS (
            SELECT 1
            FROM dbo.Consultas
            WHERE Id = @ConsultaId
              AND LTRIM(RTRIM(ISNULL(Status, N''))) <> N'Confirmada'
        )
        BEGIN
            UPDATE dbo.ChatsAtivos
            SET Ativo = 0
            WHERE ConsultaId = @ConsultaId
              AND Ativo = 1;
        END

        DECLARE @ConfirmacaoAutomaticaAtual BIT = 0;
        SELECT @ConfirmacaoAutomaticaAtual = ISNULL(f.ConfirmacaoAutomatica, 0)
        FROM dbo.Fisioterapeutas f
        WHERE f.Id = @FisioId;

        DECLARE
            @StatusAtual NVARCHAR(60),
            @StatusPagamentoAtual NVARCHAR(100),
            @IsentoTaxaServico BIT,
            @IsentoIntermediacao BIT;

        SELECT
            @StatusAtual = c.Status,
            @StatusPagamentoAtual = c.StatusPagamento,
            @IsentoTaxaServico = ISNULL(c.IsentoTaxaServico, 0),
            @IsentoIntermediacao = ISNULL(c.IsentoIntermediacao, 0),
            @ValorTransacao = CASE
                WHEN ISNULL(@ValorTransacao, 0) <= 0 THEN CAST(ISNULL(c.ValorConsulta, 0) AS DECIMAL(18,2))
                ELSE @ValorTransacao
            END
        FROM dbo.Consultas c
        WHERE c.Id = @ConsultaId;

        IF ISNULL(@ValorTransacao, 0) > 0
        BEGIN
            EXEC dbo.SP_Financeiro_RegistrarDecomposicao
                @TipoOrigem = N'Consulta',
                @OrigemId = @ConsultaId,
                @ValorCobradoPaciente = @ValorTransacao,
                @ContextoCalculo = N'ConsultaAvulsa',
                @Parcelas = 1,
                @DataReferencia = @DataReferencia,
                @ConsultaId = @ConsultaId,
                @TransacaoId = @TransacaoId,
                @IsentoTaxaServico = @IsentoTaxaServico,
                @IsentoIntermediacao = @IsentoIntermediacao,
                @OrigemCalculo = N'Sistema',
                @CriadoPor = N'SP_ConfirmarConsultaAposPagamento',
                @Observacao = N'Consulta avulsa paga no gateway com antecipacao.',
                @Silencioso = 1,
                @AgoraBrasil = @Agora;
        END

        COMMIT;

        SELECT
            @ConsultaId AS ConsultaId,
            @FisioId AS FisioterapeutaId,
            @ConfirmacaoAutomaticaAtual AS ConfirmacaoAutomaticaAtual,
            @StatusPagamentoAtual AS StatusPagamento,
            @StatusAtual AS Status;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
        RAISERROR(@Err, 16, 1);
    END CATCH
END;

GO

/****** Object:  StoredProcedure [dbo].[SP_ConfirmarPagamentoGatewayAsaas]    Script Date: 19/06/2026 20:18:05 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_ConfirmarPagamentoGatewayAsaas]
    @TransacaoId INT,
    @MetodoPagamento NVARCHAR(20) = NULL,
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );

    BEGIN TRY
        BEGIN TRAN;

        DECLARE
            @StatusAtual NVARCHAR(20),
            @MetodoAtual NVARCHAR(20);

        SELECT
            @StatusAtual = Status,
            @MetodoAtual = MetodoPagamento
        FROM dbo.Transacoes WITH (UPDLOCK, HOLDLOCK)
        WHERE Id = @TransacaoId;

        IF @StatusAtual IS NULL
        BEGIN
            RAISERROR(N'Transacao nao encontrada.', 16, 1);
            ROLLBACK;
            RETURN;
        END

        IF @StatusAtual = N'Pago'
        BEGIN
            IF @MetodoAtual IS NULL AND @MetodoPagamento IN (N'PIX', N'CartaoCredito')
            BEGIN
                UPDATE dbo.Transacoes
                SET MetodoPagamento = @MetodoPagamento
                WHERE Id = @TransacaoId
                  AND MetodoPagamento IS NULL;
            END

            COMMIT;
            SELECT
                @TransacaoId AS TransacaoId,
                0 AS Confirmada;
            RETURN;
        END

        IF @StatusAtual <> N'Pendente'
        BEGIN
            RAISERROR(N'Transacao nao esta pendente.', 16, 1);
            ROLLBACK;
            RETURN;
        END

        UPDATE dbo.Transacoes
        SET Status = N'Pago',
            MetodoPagamento = CASE
                WHEN @MetodoPagamento IN (N'PIX', N'CartaoCredito') THEN @MetodoPagamento
                ELSE MetodoPagamento
            END,
            DataConfirmacao = @Agora
        WHERE Id = @TransacaoId
          AND Status = N'Pendente';

        DECLARE @Confirmacao TABLE (
            ConsultaId INT NULL,
            FisioterapeutaId INT NULL,
            ConfirmacaoAutomaticaAtual BIT NULL,
            StatusPagamento NVARCHAR(100) NULL,
            Status NVARCHAR(60) NULL
        );

        INSERT INTO @Confirmacao (
            ConsultaId,
            FisioterapeutaId,
            ConfirmacaoAutomaticaAtual,
            StatusPagamento,
            Status
        )
        EXEC dbo.SP_ConfirmarConsultaAposPagamento
            @TransacaoId = @TransacaoId,
            @AgoraBrasil = @Agora;

        COMMIT;

        SELECT TOP 1
            @TransacaoId AS TransacaoId,
            1 AS Confirmada,
            ConsultaId,
            FisioterapeutaId,
            ConfirmacaoAutomaticaAtual,
            StatusPagamento,
            Status
        FROM @Confirmacao;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
        RAISERROR(@Err, 16, 1);
    END CATCH
END

GO

/****** Object:  StoredProcedure [dbo].[SP_CriarTransacaoGatewayPendente]    Script Date: 19/06/2026 20:18:05 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_CriarTransacaoGatewayPendente]
    @ConsultaId INT,
    @PacienteId INT,
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );

    BEGIN TRY
        BEGIN TRAN;

        DECLARE
            @ConsultaPacienteId INT,
            @FisioterapeutaId INT,
            @ValorTotal DECIMAL(10,2),
            @StatusPagamento NVARCHAR(100);

        SELECT
            @ConsultaPacienteId = c.PacienteId,
            @FisioterapeutaId = c.FisioterapeutaId,
            @ValorTotal = c.ValorConsulta,
            @StatusPagamento = LTRIM(RTRIM(ISNULL(c.StatusPagamento, N'')))
        FROM dbo.Consultas c WITH (UPDLOCK, HOLDLOCK)
        WHERE c.Id = @ConsultaId
          AND c.PacienteId = @PacienteId;

        IF @ConsultaPacienteId IS NULL
        BEGIN
            RAISERROR(N'Consulta nao encontrada para este paciente.', 16, 1);
            ROLLBACK;
            RETURN;
        END

        IF @StatusPagamento <> N'Pendente'
        BEGIN
            RAISERROR(N'Consulta nao esta aguardando pagamento.', 16, 1);
            ROLLBACK;
            RETURN;
        END

        IF ISNULL(@ValorTotal, 0) <= 0
        BEGIN
            RAISERROR(N'Valor da consulta invalido para checkout.', 16, 1);
            ROLLBACK;
            RETURN;
        END

        DECLARE
            @TransacaoExistente INT = NULL,
            @StatusExistente NVARCHAR(20) = NULL;

        SELECT TOP 1
            @TransacaoExistente = Id,
            @StatusExistente = Status
        FROM dbo.Transacoes WITH (UPDLOCK, HOLDLOCK)
        WHERE ConsultaId = @ConsultaId
          AND Status IN (N'Pendente', N'Pago')
        ORDER BY CASE WHEN Status = N'Pago' THEN 0 ELSE 1 END, Id DESC;

        IF @TransacaoExistente IS NOT NULL
        BEGIN
            COMMIT;
            SELECT
                @TransacaoExistente AS TransacaoId,
                0 AS Criada,
                @StatusExistente AS Status;
            RETURN;
        END

        INSERT INTO dbo.Transacoes
            (ConsultaId, PacienteId, FisioterapeutaId, ValorTotal,
             MetodoPagamento, Status, DataCriacao)
        VALUES
            (@ConsultaId, @PacienteId, @FisioterapeutaId, @ValorTotal,
             NULL, N'Pendente', @Agora);

        DECLARE @NovaId INT = CONVERT(INT, SCOPE_IDENTITY());

        COMMIT;
        SELECT
            @NovaId AS TransacaoId,
            1 AS Criada,
            N'Pendente' AS Status;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
        RAISERROR(@Err, 16, 1);
    END CATCH
END

GO

/****** Object:  StoredProcedure [dbo].[SP_Financeiro_RecalcularDecomposicaoGatewayAsaasV108]    Script Date: 19/06/2026 20:18:05 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_Financeiro_RecalcularDecomposicaoGatewayAsaasV108]
    @TransacaoId INT = NULL,
    @PacoteId INT = NULL,
    @MetodoPagamento NVARCHAR(30) = NULL,
    @GatewayValorLiquidoReal DECIMAL(18,2) = NULL,
    @CriadoPor NVARCHAR(100) = NULL,
    @Observacao NVARCHAR(500) = NULL,
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );

    IF (@TransacaoId IS NULL OR @TransacaoId <= 0) AND (@PacoteId IS NULL OR @PacoteId <= 0)
        THROW 51260, N'Informe TransacaoId ou PacoteId.', 1;

    DECLARE
        @TipoOrigem NVARCHAR(30),
        @OrigemId INT,
        @ConsultaId INT = NULL,
        @PacoteIdSnapshot INT = NULL,
        @TransacaoIdSnapshot INT = NULL,
        @ValorCobradoPaciente DECIMAL(18,2),
        @ContextoCalculo NVARCHAR(30),
        @Parcelas TINYINT,
        @DataReferencia DATE,
        @IsentoTaxaServico BIT = 0,
        @IsentoIntermediacao BIT = 0,
        @MetodoPagamentoEfetivo NVARCHAR(30);

    SET @MetodoPagamento = NULLIF(LTRIM(RTRIM(@MetodoPagamento)), N'');

    IF @TransacaoId IS NOT NULL AND @TransacaoId > 0
    BEGIN
        SELECT TOP (1)
            @TipoOrigem = N'Consulta',
            @OrigemId = t.ConsultaId,
            @ConsultaId = t.ConsultaId,
            @TransacaoIdSnapshot = t.Id,
            @ValorCobradoPaciente = CAST(ISNULL(t.ValorTotal, 0) AS DECIMAL(18,2)),
            @ContextoCalculo = N'ConsultaAvulsa',
            @Parcelas = 1,
            @DataReferencia = CAST(COALESCE(t.DataConfirmacao, t.DataCriacao, c.DataHora, @Agora) AS DATE),
            @IsentoTaxaServico = ISNULL(c.IsentoTaxaServico, 0),
            @IsentoIntermediacao = ISNULL(c.IsentoIntermediacao, 0),
            @MetodoPagamentoEfetivo = COALESCE(@MetodoPagamento, NULLIF(LTRIM(RTRIM(t.MetodoPagamento)), N''))
        FROM dbo.Transacoes t
        INNER JOIN dbo.Consultas c ON c.Id = t.ConsultaId
        WHERE t.Id = @TransacaoId
          AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago';
    END
    ELSE
    BEGIN
        SELECT TOP (1)
            @TipoOrigem = N'Pacote',
            @OrigemId = p.Id,
            @PacoteIdSnapshot = p.Id,
            @ValorCobradoPaciente = CAST(COALESCE(p.ValorPago, p.ValorTotal, 0) AS DECIMAL(18,2)),
            @ContextoCalculo = N'Pacote',
            @Parcelas = 10,
            @DataReferencia = CAST(COALESCE(p.PagoEm, p.DataCompra, p.CriadoEm, @Agora) AS DATE),
            @IsentoTaxaServico = 0,
            @IsentoIntermediacao = 0,
            @MetodoPagamentoEfetivo = COALESCE(@MetodoPagamento, NULLIF(LTRIM(RTRIM(p.MetodoPagamento)), N''))
        FROM dbo.Pacotes p
        WHERE p.Id = @PacoteId
          AND LTRIM(RTRIM(ISNULL(p.Status, N''))) = N'Ativo';
    END

    IF @OrigemId IS NULL OR ISNULL(@ValorCobradoPaciente, 0) <= 0
        RETURN;

    DECLARE @Calc TABLE
    (
        ValorFinalPaciente DECIMAL(18,2),
        ContextoCalculo NVARCHAR(30),
        Parcelas TINYINT,
        GatewayPerfilCustoId INT NULL,
        TaxaGatewayPrecificacao DECIMAL(10,4),
        TaxaGatewayRealPercentual DECIMAL(10,4),
        TaxaGatewayAntecipacaoMensal DECIMAL(10,4) NULL,
        TaxaServico DECIMAL(10,4),
        TaxaIntermediacao DECIMAL(10,4),
        PrazoDias SMALLINT NULL,
        FixoPor NVARCHAR(20) NULL,
        ValorBase DECIMAL(18,2),
        ValorGatewayPercentual DECIMAL(18,2),
        ValorGatewayFixo DECIMAL(18,2),
        ValorGatewayAntecipacao DECIMAL(18,2),
        ValorLiquidoGateway DECIMAL(18,2),
        ValorServicoPlataforma DECIMAL(18,2),
        ValorIntermediacao DECIMAL(18,2),
        ValorRepasseFisio DECIMAL(18,2),
        ReceitaContratualPlataforma DECIMAL(18,2),
        ResultadoPosGatewayPlataforma DECIMAL(18,2),
        GapGateway DECIMAL(18,2)
    );

    BEGIN TRY
        BEGIN TRAN;

        DELETE FROM dbo.FinanceiroDecomposicoes
        WHERE TipoOrigem = @TipoOrigem
          AND OrigemId = @OrigemId
          AND OrigemCalculo = N'Sistema';

        INSERT INTO @Calc
        SELECT
            ValorFinalPaciente,
            ContextoCalculo,
            Parcelas,
            GatewayPerfilCustoId,
            TaxaGatewayPrecificacao,
            TaxaGatewayRealPercentual,
            TaxaGatewayAntecipacaoMensal,
            TaxaServico,
            TaxaIntermediacao,
            PrazoDias,
            FixoPor,
            ValorBase,
            ValorGatewayPercentual,
            ValorGatewayFixo,
            ValorGatewayAntecipacao,
            ValorLiquidoGateway,
            ValorServicoPlataforma,
            ValorIntermediacao,
            ValorRepasseFisio,
            ReceitaContratualPlataforma,
            ResultadoPosGatewayPlataforma,
            GapGateway
        FROM dbo.fn_DecomporValorPacienteV3(
            @ValorCobradoPaciente,
            @ContextoCalculo,
            @Parcelas,
            @DataReferencia,
            @IsentoTaxaServico,
            @IsentoIntermediacao,
            @MetodoPagamentoEfetivo,
            @GatewayValorLiquidoReal
        );

        INSERT INTO dbo.FinanceiroDecomposicoes
        (
            TipoOrigem, OrigemId, ConsultaId, PacoteId, TransacaoId, CreditoPacienteId,
            GatewayPerfilCustoId, Parcelas, ContextoCalculo,
            TaxaIntermediacao, TaxaServico, TaxaGatewayPrecificacao,
            TaxaGatewayRealPercentual, TaxaGatewayAntecipacaoMensal, PrazoDias, FixoPor,
            ValorBase, ValorCobradoPaciente, ValorGatewayPercentual, ValorGatewayFixo,
            ValorGatewayAntecipacao, ValorLiquidoGateway, ValorIntermediacao,
            ValorServicoPlataforma, ValorRepasseFisio, ReceitaContratualPlataforma,
            ResultadoPosGatewayPlataforma, GapGateway,
            DataReferencia, OrigemCalculo, CriadoPor, Observacao
        )
        SELECT
            @TipoOrigem, @OrigemId, @ConsultaId, @PacoteIdSnapshot, @TransacaoIdSnapshot, NULL,
            GatewayPerfilCustoId, Parcelas, @ContextoCalculo,
            TaxaIntermediacao, TaxaServico, TaxaGatewayPrecificacao,
            TaxaGatewayRealPercentual, TaxaGatewayAntecipacaoMensal, PrazoDias, FixoPor,
            ValorBase, @ValorCobradoPaciente, ValorGatewayPercentual, ValorGatewayFixo,
            ValorGatewayAntecipacao, ValorLiquidoGateway, ValorIntermediacao,
            ValorServicoPlataforma, ValorRepasseFisio, ReceitaContratualPlataforma,
            ResultadoPosGatewayPlataforma, GapGateway,
            @DataReferencia, N'Sistema', COALESCE(@CriadoPor, N'ASAAS_WEBHOOK'),
            COALESCE(@Observacao, N'Custo gateway recalculado pelo Asaas V108.')
        FROM @Calc;

        COMMIT;

        SELECT TOP (1) *
        FROM dbo.vw_FinanceiroDecomposicoes
        WHERE TipoOrigem = @TipoOrigem
          AND OrigemId = @OrigemId
          AND OrigemCalculo = N'Sistema'
        ORDER BY Id DESC;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
    END CATCH
END;

GO

/****** Object:  StoredProcedure [dbo].[SP_Financeiro_RegistrarPacotePago]    Script Date: 19/06/2026 20:18:05 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

/* ============================================================
   2) Helper idempotente para snapshot de pacote pago
      Pacote usa perfil conservador 7x-10x (Parcelas = 10), sem antecipacao.
   ============================================================ */
CREATE OR ALTER PROCEDURE [dbo].[SP_Financeiro_RegistrarPacotePago]
    @PacoteId INT,
    @CriadoPor NVARCHAR(100) = NULL,
    @Silencioso BIT = 0,
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );

    DECLARE
        @ValorCobrado DECIMAL(18,2),
        @DataReferencia DATE,
        @Status NVARCHAR(60),
        @GatewayStatus NVARCHAR(120);

    SELECT
        @ValorCobrado = CAST(COALESCE(p.ValorPago, p.ValorTotal, 0) AS DECIMAL(18,2)),
        @DataReferencia = CAST(COALESCE(p.PagoEm, p.DataCompra, p.CriadoEm, @Agora) AS DATE),
        @Status = LTRIM(RTRIM(ISNULL(p.Status, N''))),
        @GatewayStatus = LTRIM(RTRIM(ISNULL(p.GatewayStatus, N'')))
    FROM dbo.Pacotes p
    WHERE p.Id = @PacoteId;

    IF @ValorCobrado IS NULL
        THROW 51080, N'Pacote nao encontrado.', 1;

    IF @ValorCobrado <= 0
        THROW 51081, N'Pacote sem valor para snapshot financeiro.', 1;

    IF @Status <> N'Ativo' AND @GatewayStatus NOT IN (N'Pago', N'CreditoCarteira')
        THROW 51082, N'Pacote ainda nao esta pago/ativo para snapshot financeiro.', 1;

    EXEC dbo.SP_Financeiro_RegistrarDecomposicao
        @TipoOrigem = N'Pacote',
        @OrigemId = @PacoteId,
        @ValorCobradoPaciente = @ValorCobrado,
        @ContextoCalculo = N'Pacote',
        @Parcelas = 10,
        @DataReferencia = @DataReferencia,
        @PacoteId = @PacoteId,
        @OrigemCalculo = N'Sistema',
        @CriadoPor = @CriadoPor,
        @Observacao = N'Pacote pago sem antecipacao; perfil conservador max. 10x.',
        @Silencioso = @Silencioso,
        @AgoraBrasil = @Agora;
END;

GO

/****** Object:  StoredProcedure [dbo].[SP_Pacote_GerarCreditos]    Script Date: 19/06/2026 20:18:05 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO


CREATE OR ALTER PROCEDURE [dbo].[SP_Pacote_GerarCreditos]
  @PacoteId INT,
  @PacienteId INT,
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );

  BEGIN TRY
    BEGIN TRAN;

    DECLARE @Qtd INT, @ValorTotal DECIMAL(10,2), @PacienteIdPacote INT;

    SELECT
      @Qtd = p.QuantidadeConsultas,
      @ValorTotal = p.ValorTotal,
      @PacienteIdPacote = p.PacienteId
    FROM dbo.Pacotes p WITH (UPDLOCK, HOLDLOCK)
    WHERE p.Id = @PacoteId;

    IF @Qtd IS NULL OR @Qtd <= 0
      RAISERROR(N'Pacote inválido (QuantidadeConsultas).', 16, 1);

    IF @ValorTotal IS NULL OR @ValorTotal <= 0
      RAISERROR(N'Pacote inválido (ValorTotal).', 16, 1);

    IF @PacienteIdPacote <> @PacienteId
      RAISERROR(N'Pacote não pertence ao paciente informado.', 16, 1);

    -- Evita gerar créditos duplicados para o mesmo pacote
    IF EXISTS (SELECT 1 FROM dbo.CreditosPacientes WHERE PacoteId = @PacoteId)
      RAISERROR(N'Créditos deste pacote já foram gerados.', 16, 1);

    -- Distribuição em centavos (inteiro)
    DECLARE @TotalCentavos INT = CAST(ROUND(@ValorTotal * 100.0, 0) AS INT);
    DECLARE @BaseCentavos INT = @TotalCentavos / @Qtd;      -- piso
    DECLARE @Resto INT       = @TotalCentavos % @Qtd;       -- sobra 0..Qtd-1

    ;WITH N AS (
      SELECT TOP (@Qtd)
        ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
      FROM sys.all_objects
    )
    INSERT INTO dbo.CreditosPacientes (PacienteId, ConsultaId, Valor, Status, CriadoEm, UsadoEm, Motivo, PacoteId)
    SELECT
      @PacienteId,
      NULL,
      CAST((@BaseCentavos + CASE WHEN n <= @Resto THEN 1 ELSE 0 END) / 100.0 AS DECIMAL(10,2)),
      N'Disponivel',
      @Agora,
      NULL,
	   -- Não alterar essa descrição abaixo "Crédito gerado por compra do pacote ..."
      CONCAT(N'Crédito gerado por compra do pacote #', @PacoteId),
      @PacoteId
    FROM N;

    COMMIT;

    SELECT
      @PacoteId AS PacoteId,
      @PacienteId AS PacienteId,
      @Qtd AS QuantidadeConsultas,
      @ValorTotal AS ValorTotal;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
    RAISERROR(@Err, 16, 1);
  END CATCH
END;
GO
SELECT
  CAST(1 AS bit) AS Sucesso,
  N'AZURE_TIMEZONE_STORED_PROCS_V115 aplicado. Stored procedures passam a usar @AgoraBrasil/fallback Sao Paulo.' AS Mensagem;
GO

-- Teste recomendado apos aplicar em homolog Azure SQL:
-- 1) Chamar uma SP sem @AgoraBrasil (fallback SQL puro) e confirmar que timestamps gravados ficam em horario de Brasilia/Sao Paulo.
-- 2) Chamar a mesma SP passando @AgoraBrasil pelo backend e confirmar snapshot consistente na cadeia de SPs.

