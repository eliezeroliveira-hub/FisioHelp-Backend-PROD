SET XACT_ABORT ON;
GO

/****** Object:  StoredProcedure [dbo].[SP_ExecutarJobPadronizado]    Script Date: 22/06/2026 10:02:10 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_ExecutarJobPadronizado]
    @NomeJob NVARCHAR(200),
    @ComandoSQL NVARCHAR(MAX),
    @OrigemExecucao NVARCHAR(100) = N'Manual',
    @FalharEmErro BIT = 1,
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @InicioUtc DATETIME2(7) = SYSUTCDATETIME();
    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );
    DECLARE
        @Status NVARCHAR(100) = N'OK',
        @Mensagem NVARCHAR(MAX) = N'Execução concluída com sucesso.',
        @DuracaoSegundos INT;

    DECLARE
        @ErrNumber INT = NULL,
        @ErrLine   INT = NULL,
        @ErrProc   NVARCHAR(200) = NULL;

    BEGIN TRY
        EXEC sys.sp_executesql @ComandoSQL;
    END TRY
    BEGIN CATCH
        SET @Status = N'ERRO';

        SET @ErrNumber = ERROR_NUMBER();
        SET @ErrLine   = ERROR_LINE();
        SET @ErrProc   = ERROR_PROCEDURE();

        SET @Mensagem = CONCAT(
            N'Erro: ', ERROR_MESSAGE(),
            N' (Proc ', ISNULL(@ErrProc, N'(n/a)'),
            N', Linha ', @ErrLine,
            N', Nº ', @ErrNumber, N')'
        );
    END CATCH;

    SET @DuracaoSegundos = DATEDIFF(SECOND, @InicioUtc, SYSUTCDATETIME());

    INSERT INTO dbo.LogsJobs
        (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao)
    VALUES
        (@NomeJob, @Status, @Mensagem, @DuracaoSegundos, @Agora,
         HOST_NAME(), SUSER_SNAME(), @OrigemExecucao);

    PRINT CONCAT('Job "', @NomeJob, '" finalizado com status ', @Status, '.');

    -- ✅ Faz o step do SQL Agent falhar (se você quiser)
    IF @Status = N'ERRO' AND @FalharEmErro = 1
    BEGIN
        DECLARE @MsgShort NVARCHAR(2047) = LEFT(@Mensagem, 2047);
        THROW 51000, @MsgShort, 1;
    END
END;
GO
/****** Object:  StoredProcedure [dbo].[sp_RegistrarLogJob]    Script Date: 22/06/2026 10:02:10 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[sp_RegistrarLogJob]
    @JobName NVARCHAR(200),
    @Status NVARCHAR(50),
    @Mensagem NVARCHAR(4000),
    @DuracaoSegundos INT,
    @DataExecucao DATETIME2(7) = NULL,
    @Usuario NVARCHAR(128),
    @OrigemExecucao NVARCHAR(50),
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );
    INSERT INTO dbo.LogsJobs
        (NomeJob, Status, Mensagem, DuracaoSegundos, DataExecucao, Servidor, UsuarioExecucao, OrigemExecucao)
    VALUES
        (@JobName, @Status, @Mensagem, @DuracaoSegundos, COALESCE(@DataExecucao, @Agora), HOST_NAME(), @Usuario, @OrigemExecucao);
END;
GO
/****** Object:  StoredProcedure [dbo].[sp_ExpirarPremiumVencidos]    Script Date: 22/06/2026 10:02:10 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[sp_ExpirarPremiumVencidos]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );

    BEGIN TRAN;

    DECLARE @Hoje DATE = CAST(@Agora AS DATE);

    --------------------------------------------------------------
    -- 1. Desativar assinaturas premium vencidas
    --------------------------------------------------------------
    UPDATE dbo.AssinaturasPremium
    SET Ativa = 0
    WHERE Ativa = 1
      AND DataFim < @Hoje;   -- já venceu

    --------------------------------------------------------------
    -- 2. Fisioterapeutas que devem voltar para conta comum
    --------------------------------------------------------------
    UPDATE f
    SET f.TipoConta = 'Comum'
    FROM dbo.Fisioterapeutas f
    INNER JOIN dbo.AssinaturasPremium ap
        ON ap.FisioterapeutaId = f.Id
    WHERE ap.DataFim < @Hoje
      AND ap.Ativa = 0       -- já desativado agora
      AND f.TipoConta = 'Premium';

    --------------------------------------------------------------
    -- 3. Segurança extra: verificar se existem outras assinaturas ativas
    -- (caso futuro de upgrades, mais meses, promoções, etc.)
    --------------------------------------------------------------
    UPDATE f
    SET f.TipoConta = 'Premium'
    FROM dbo.Fisioterapeutas f
    WHERE EXISTS (
        SELECT 1
        FROM dbo.AssinaturasPremium ap
        WHERE ap.FisioterapeutaId = f.Id
          AND ap.Ativa = 1
          AND ap.DataFim >= @Hoje   -- ainda válido
    );

    COMMIT;
END
GO
/****** Object:  StoredProcedure [dbo].[sp_Job_ExpirarPremiumVencidos]    Script Date: 22/06/2026 10:02:10 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[sp_Job_ExpirarPremiumVencidos]
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @InicioUtc DATETIME2(7) = SYSUTCDATETIME();
    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );
    DECLARE
        @Mensagem NVARCHAR(4000),
        @Status NVARCHAR(50),
        @Duracao INT;

    BEGIN TRY

        -- Executa a SP real
        EXEC dbo.sp_ExpirarPremiumVencidos @AgoraBrasil = @Agora;

        SET @Status = 'OK';
        SET @Mensagem = 'Execução concluída com sucesso.';

    END TRY
    BEGIN CATCH

        SET @Status = 'ERRO';

        SET @Mensagem = CONCAT(
            'Erro: ', ERROR_MESSAGE(),
            ' | Linha: ', ERROR_LINE(),
            ' | Procedimento: ', ERROR_PROCEDURE()
        );

    END CATCH;

    SET @Duracao = DATEDIFF(SECOND, @InicioUtc, SYSUTCDATETIME());

    ------------------------------------------------------------
    -- Registro de Log em dbo.LogsJobs
    ------------------------------------------------------------
    INSERT INTO dbo.LogsJobs
    (
        NomeJob,
        Status,
        Mensagem,
        DuracaoSegundos,
        DataExecucao,
        Servidor,
        UsuarioExecucao,
        OrigemExecucao
    )
    VALUES
    (
        'ExpirarPremiumVencidos',         -- Nome do job
        @Status,                          -- OK ou ERRO
        @Mensagem,                        -- Detalhes
        @Duracao,                         -- Duração
        @Agora,                           -- Momento da execução
        @@SERVERNAME,                     -- Servidor atual
        SUSER_SNAME(),                    -- Conta que executou
        'SQL Agent'                       -- Origem
    );
END
GO
/****** Object:  StoredProcedure [dbo].[SP_VerificarConsultasExpiradas]    Script Date: 22/06/2026 10:02:10 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_VerificarConsultasExpiradas]
    @HorasSemConfirmacao INT = 24,
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

        -----------------------------------------------------------------
        -- 0) Contexto Admin (bypass RLS) para execução por Job/SQL Agent
        -----------------------------------------------------------------
        DECLARE @CtxTipo NVARCHAR(40) = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40));
        DECLARE @CtxId   INT          = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));
        DECLARE @AdminId INT;

        IF (@CtxTipo IS NULL OR @CtxTipo <> N'Admin' OR @CtxId IS NULL)
        BEGIN
            SELECT TOP (1) @AdminId = Id
            FROM dbo.Administradores
            WHERE Ativo = 1
            ORDER BY Id;

            IF @AdminId IS NOT NULL
            BEGIN
                EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin';
                EXEC sys.sp_set_session_context @key = N'UsuarioId',   @value = @AdminId;
            END
        END

        -----------------------------------------------------------------
        -- 1) Alvos: consultas "Aguardando" há >= @HorasSemConfirmacao
        --    Distinguindo pagamento com pacote, crédito na carteira
        --    e pagamento em dinheiro/plataforma.
        -----------------------------------------------------------------
        DECLARE @Alvos TABLE
        (
            ConsultaId             INT PRIMARY KEY,
            PacienteId             INT NOT NULL,
            FisioterapeutaId       INT NULL,
            StatusPagamento        NVARCHAR(100) NULL,
            Valor                  DECIMAL(10,2) NOT NULL,
            PagamentoViaPlataforma BIT NOT NULL,
            OrigemPagamento        NVARCHAR(100) NULL,
            PagoComPacote          BIT NOT NULL,
            PagoComCreditoCarteira BIT NOT NULL
        );

        INSERT INTO @Alvos
        (
            ConsultaId,
            PacienteId,
            FisioterapeutaId,
            StatusPagamento,
            Valor,
            PagamentoViaPlataforma,
            OrigemPagamento,
            PagoComPacote,
            PagoComCreditoCarteira
        )
        SELECT
            c.Id,
            c.PacienteId,
            c.FisioterapeutaId,
            LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))) AS StatusPagamento,
            ISNULL(c.ValorConsulta, 0)                   AS Valor,
            ISNULL(c.PagamentoViaPlataforma, 1)          AS PagamentoViaPlataforma,
            LTRIM(RTRIM(ISNULL(c.OrigemPagamento, N''))) AS OrigemPagamento,
            CAST(
                CASE
                    WHEN EXISTS (
                        SELECT 1
                        FROM dbo.CreditosPacientes cp
                        WHERE cp.ConsultaId = c.Id
                          AND cp.PacienteId = c.PacienteId
                          AND cp.PacoteId IS NOT NULL
                    )
                    THEN 1 ELSE 0
                END
            AS BIT) AS PagoComPacote,
            CAST(
                CASE
                    WHEN EXISTS (
                        SELECT 1
                        FROM dbo.CreditosPacientes cp
                        WHERE cp.ConsultaId = c.Id
                          AND cp.PacienteId = c.PacienteId
                          AND cp.PacoteId IS NULL
                    )
                    THEN 1 ELSE 0
                END
            AS BIT) AS PagoComCreditoCarteira
        FROM dbo.Consultas c
        WHERE
            LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Aguardando'
            AND ISNULL(c.ConfirmacaoAutomatica, 0) = 0
            -- [CORREÇÃO 3] DATEADD garante 24h exatas; DATEDIFF(HOUR) podia disparar
            -- até 59 min antes por contar bordas de hora, não tempo real decorrido.
            AND @Agora >= DATEADD(HOUR, @HorasSemConfirmacao, c.DataHora);

        IF NOT EXISTS (SELECT 1 FROM @Alvos)
            RETURN;

        DECLARE @MotivoMaxBytes INT = COL_LENGTH('dbo.CreditosPacientes', 'Motivo');
        DECLARE @MotivoMaxChars INT =
            CASE
                WHEN @MotivoMaxBytes IS NULL OR @MotivoMaxBytes <= 0 THEN 400
                ELSE (@MotivoMaxBytes / 2)
            END;

        -- [CORREÇÃO 1] Transação explícita envolvendo todos os passos de mutação
        -- (2-7). Sem isso cada UPDATE/INSERT confirmava em auto-commit separado:
        -- uma falha no passo 4 deixava a consulta Cancelada mas o crédito Usado.
        BEGIN TRAN;

        -----------------------------------------------------------------
        -- 2) Cancela + encerra consulta
        -----------------------------------------------------------------
        UPDATE c
           SET c.Status             = N'Cancelada',
               c.ChatLiberado       = 0,
               c.ChatLiberadoEm     = NULL,
               c.DataEncerramento   = ISNULL(c.DataEncerramento, @Agora),
               c.MotivoEncerramento = ISNULL(
                   c.MotivoEncerramento,
                   CONCAT(N'Cancelamento automático após ', @HorasSemConfirmacao, N'h sem confirmação.')
               ),
               c.StatusPagamento =
                   CASE
                       WHEN a.Valor > 0
                            AND (
                                a.PagoComPacote = 1
                                OR a.PagoComCreditoCarteira = 1
                                OR (
                                    a.StatusPagamento = N'Pago'
                                    AND (
                                        a.PagamentoViaPlataforma = 1
                                        OR a.OrigemPagamento IN (N'Plataforma', N'Carteira')
                                    )
                                )
                            )
                       THEN N'CreditoPaciente'
                       ELSE c.StatusPagamento
                   END
        FROM dbo.Consultas c
        INNER JOIN @Alvos a ON a.ConsultaId = c.Id;

        -----------------------------------------------------------------
        -- 3) Inativa chat(s) ativo(s) da consulta
        -----------------------------------------------------------------
        UPDATE ca
           SET ca.Ativo = 0
        FROM dbo.ChatsAtivos ca
        INNER JOIN @Alvos a ON a.ConsultaId = ca.ConsultaId
        WHERE ca.Ativo = 1;

        -----------------------------------------------------------------
        -- 4) Pago com PACOTE: devolve a sessão ao pacote
        --    - crédito volta a Disponivel (sem ConsultaId)
        --    - decrementa ConsultasUtilizadas
        --    - NÃO gera crédito na carteira
        -----------------------------------------------------------------
        DECLARE @CreditosPacoteAjustados TABLE
        (
            PacoteId INT NOT NULL
        );

        UPDATE cp
           SET cp.Status     = N'Disponivel',
               cp.UsadoEm   = NULL,
               cp.OrigemConsultaId = CASE
                   WHEN cp.OrigemConsultaId IS NULL
                    AND cp.OrigemPacoteId IS NULL
                    AND cp.PacoteId IS NULL
                   THEN cp.ConsultaId
                   ELSE cp.OrigemConsultaId
               END,
               cp.ConsultaId = NULL,
               cp.Motivo     = LEFT(
                   CONCAT(
                       COALESCE(NULLIF(cp.Motivo, N''), N''),
                       CASE WHEN cp.Motivo IS NULL OR cp.Motivo = N'' THEN N'' ELSE N' | ' END,
                       N'Cancelado automaticamente após ',
                       @HorasSemConfirmacao,
                       N'h sem confirmação.'
                   ),
                   @MotivoMaxChars
               )
           OUTPUT inserted.PacoteId INTO @CreditosPacoteAjustados (PacoteId)
        FROM dbo.CreditosPacientes cp WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN @Alvos a
            ON a.ConsultaId = cp.ConsultaId
           AND a.PacienteId = cp.PacienteId
        WHERE a.PagoComPacote = 1
          AND cp.PacoteId IS NOT NULL;

        ;WITH PacotesImpactados AS
        (
            SELECT PacoteId, COUNT(1) AS Quantidade
            FROM @CreditosPacoteAjustados
            GROUP BY PacoteId
        )
        UPDATE p
           SET p.ConsultasUtilizadas =
               CASE
                   WHEN ISNULL(p.ConsultasUtilizadas, 0) > pi.Quantidade
                       THEN ISNULL(p.ConsultasUtilizadas, 0) - pi.Quantidade
                   ELSE 0
               END
        FROM dbo.Pacotes p
        INNER JOIN PacotesImpactados pi ON pi.PacoteId = p.Id;

        -----------------------------------------------------------------
        -- 5) Pago com CRÉDITO NA CARTEIRA: reativa o crédito existente
        --    NÃO cria novo crédito
        -- [CORREÇÃO 2] ConsultaId = NULL adicionado: sem isso o crédito
        --    restaurado permanecia apontando para a consulta cancelada,
        --    tornando-o invisível para SPs que filtram ConsultaId IS NULL.
        -- [CORREÇÃO 4] AND cp.Status = N'Usado' adicionado: defensivo —
        --    evita alterar um crédito que já esteja Disponivel mas que
        --    coincidentemente aponte para esta ConsultaId.
        -----------------------------------------------------------------
        UPDATE cp
           SET cp.Status     = N'Disponivel',
               cp.UsadoEm   = NULL,
               cp.OrigemConsultaId = CASE
                   WHEN cp.OrigemConsultaId IS NULL
                    AND cp.OrigemPacoteId IS NULL
                    AND cp.PacoteId IS NULL
                   THEN cp.ConsultaId
                   ELSE cp.OrigemConsultaId
               END,
               cp.ConsultaId = NULL,
               cp.Motivo     = LEFT(
                   CONCAT(
                       COALESCE(NULLIF(cp.Motivo, N''), N''),
                       CASE WHEN cp.Motivo IS NULL OR cp.Motivo = N'' THEN N'' ELSE N' | ' END,
                       N'Cancelado automaticamente após ',
                       @HorasSemConfirmacao,
                       N'h sem confirmação.'
                   ),
                   @MotivoMaxChars
               )
        FROM dbo.CreditosPacientes cp WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN @Alvos a
            ON a.ConsultaId = cp.ConsultaId
           AND a.PacienteId = cp.PacienteId
        WHERE a.PagoComCreditoCarteira = 1
          AND cp.PacoteId IS NULL
          AND cp.Status   = N'Usado';

        -----------------------------------------------------------------
        -- 6) Pago em dinheiro/plataforma: gera crédito na carteira
        --    (somente se NÃO for pacote e NÃO for crédito pré-existente)
        -----------------------------------------------------------------
        BEGIN TRY
            INSERT INTO dbo.CreditosPacientes
                (PacienteId, ConsultaId, OrigemConsultaId, Valor, Motivo)
            SELECT
                a.PacienteId,
                NULL,
                a.ConsultaId,
                a.Valor,
                CONCAT(
                    N'Crédito gerado por cancelamento automático após ',
                    @HorasSemConfirmacao,
                    N'h sem confirmação.'
                )
            FROM @Alvos a
            WHERE a.PagoComPacote = 0
              AND a.PagoComCreditoCarteira = 0
              AND a.StatusPagamento = N'Pago'
              AND (
                  a.PagamentoViaPlataforma = 1
                  OR a.OrigemPagamento IN (N'Plataforma', N'Carteira')
              )
              AND a.Valor > 0
              AND NOT EXISTS (
                  SELECT 1
                  FROM dbo.CreditosPacientes cp WITH (UPDLOCK, HOLDLOCK)
                  WHERE cp.PacienteId = a.PacienteId
                    AND (
                      cp.ConsultaId = a.ConsultaId
                      OR cp.OrigemConsultaId = a.ConsultaId
                    )
              );
        END TRY
        BEGIN CATCH
            IF ERROR_NUMBER() NOT IN (2601, 2627) THROW;
        END CATCH;

        -----------------------------------------------------------------
        -- 7) Logs
        -----------------------------------------------------------------
        INSERT INTO dbo.ConsultasLogs
            (ConsultaId, Evento, Descricao, UsuarioTipo, UsuarioId)
        SELECT
            a.ConsultaId,
            N'CancelamentoAutomatico',
            CONCAT(
                N'Consulta cancelada automaticamente após ',
                @HorasSemConfirmacao,
                N'h sem confirmação.'
            ),
            N'Sistema',
            NULL
        FROM @Alvos a;

        COMMIT;

        PRINT N'OK - Consultas expiradas canceladas. Pacote volta para o pacote; crédito em carteira volta para a carteira; pagamento em dinheiro gera crédito na carteira.';

    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();

        INSERT INTO dbo.AuditoriaTriggersLogs
            (TabelaAfetada, Acao, RegistroId, UsuarioSistema, MensagemDetalhe)
        VALUES
            (N'dbo.Consultas', N'ERRO - SP_VerificarConsultasExpiradas', NULL, SUSER_SNAME(), @Err);

        RAISERROR(@Err, 16, 1);
    END CATCH
END;
GO
/****** Object:  StoredProcedure [dbo].[SP_MarcarNoShow]    Script Date: 22/06/2026 10:02:10 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_MarcarNoShow]
    @JanelaMinutos INT = 10,
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
        ---------------------------------------------------------------------
        -- 0) Contexto Admin (se existir RLS)
        ---------------------------------------------------------------------
        DECLARE @CtxTipo NVARCHAR(40) = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40));
        DECLARE @CtxId   INT          = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));
        DECLARE @AdminId INT;

        IF (@CtxTipo IS NULL OR @CtxTipo <> N'Admin' OR @CtxId IS NULL)
        BEGIN
            SELECT TOP (1) @AdminId = Id
            FROM dbo.Administradores
            WHERE Ativo = 1
            ORDER BY Id;

            IF @AdminId IS NOT NULL
            BEGIN
                EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin';
                EXEC sys.sp_set_session_context @key = N'UsuarioId',   @value = @AdminId;
            END
        END

        ---------------------------------------------------------------------
        -- 1) Alvos
        ---------------------------------------------------------------------
        IF OBJECT_ID('tempdb..#Alvos') IS NOT NULL DROP TABLE #Alvos;

        SELECT c.Id
        INTO #Alvos
        FROM dbo.Consultas c
        WHERE c.CheckinHora IS NOT NULL
          AND ISNULL(c.ConfirmacaoAtendimento, 0) = 0
          AND DATEDIFF(MINUTE, c.CheckinHora, @Agora) >= @JanelaMinutos
          AND LTRIM(RTRIM(ISNULL(c.Status, N''))) IN (N'Confirmada');

        IF NOT EXISTS (SELECT 1 FROM #Alvos)
            RETURN;

        IF OBJECT_ID('tempdb..#Atualizadas') IS NOT NULL DROP TABLE #Atualizadas;
        CREATE TABLE #Atualizadas (
            ConsultaId INT NOT NULL PRIMARY KEY,
            PacienteId INT NOT NULL,
            FisioterapeutaId INT NOT NULL,
            DataHora DATETIME NULL
        );

        BEGIN TRAN;

        ---------------------------------------------------------------------
        -- 2) Marca como "Paciente Ausente" + encerra na consulta
        ---------------------------------------------------------------------
        UPDATE c
           SET c.Status = N'Paciente Ausente',
               c.ChatLiberado = 0,
               c.DataEncerramento = ISNULL(c.DataEncerramento, CONVERT(datetime, @Agora)),
               c.MotivoEncerramento = ISNULL(
                    c.MotivoEncerramento,
                    CONCAT(N'Paciente não confirmou token em até ', @JanelaMinutos, N' minuto(s) após o check-in.')
               )
        OUTPUT inserted.Id, inserted.PacienteId, inserted.FisioterapeutaId, inserted.DataHora
        INTO #Atualizadas (ConsultaId, PacienteId, FisioterapeutaId, DataHora)
        FROM dbo.Consultas c
        JOIN #Alvos a ON a.Id = c.Id
        -- Revalida o status no UPDATE: protege contra execucao concorrente do job.
        WHERE LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Confirmada';

        IF NOT EXISTS (SELECT 1 FROM #Atualizadas)
        BEGIN
            COMMIT;
            RETURN;
        END

        ---------------------------------------------------------------------
        -- 3) Inativa chat(s) da consulta
        ---------------------------------------------------------------------
        UPDATE ca
           SET ca.Ativo = 0
        FROM dbo.ChatsAtivos ca
        JOIN #Atualizadas a ON a.ConsultaId = ca.ConsultaId
        WHERE ca.Ativo = 1;

        ---------------------------------------------------------------------
        -- 4) Logs
        ---------------------------------------------------------------------
        INSERT INTO dbo.ConsultasLogs (ConsultaId, Evento, Descricao, UsuarioTipo, UsuarioId)
        SELECT
            a.ConsultaId,
            N'NoShowPaciente',
            CONCAT(N'Paciente não confirmou token dentro da janela de ', @JanelaMinutos, N' minuto(s).'),
            N'Sistema',
            NULL
        FROM #Atualizadas a;

        COMMIT;

        ---------------------------------------------------------------------
        -- 5) Notificacoes: fila push + fila email + inbox in-app unico
        ---------------------------------------------------------------------
        BEGIN TRY
        ;WITH Base AS (
            SELECT
                a.ConsultaId,
                a.PacienteId,
                a.FisioterapeutaId,
                DataTexto = CASE
                    WHEN a.DataHora IS NULL THEN N''
                    ELSE CONCAT(N' de ', CONVERT(NVARCHAR(10), a.DataHora, 103), N' às ', LEFT(CONVERT(NVARCHAR(8), CAST(a.DataHora AS time), 108), 5))
                END,
                PacienteNome = COALESCE(p.Nome, N'O paciente')
            FROM #Atualizadas a
            LEFT JOIN dbo.Pacientes p ON p.Id = a.PacienteId
        ),
        Destinos AS (
            SELECT
                UsuarioTipo = N'Paciente',
                UsuarioId = PacienteId,
                Tipo = N'Agendamento',
                Titulo = N'Falta registrada',
                Mensagem = CAST(CONCAT(N'Você consta como ausente na consulta', DataTexto, N'.') AS NVARCHAR(500)),
                DadosJson = CAST(CONCAT(N'{"tipo":"paciente_ausente","consultaId":', ConsultaId, N'}') AS NVARCHAR(MAX)),
                ReferenciaId = ConsultaId
            FROM Base
            UNION ALL
            SELECT
                UsuarioTipo = N'Fisioterapeuta',
                UsuarioId = FisioterapeutaId,
                Tipo = N'Agendamento',
                Titulo = N'Paciente ausente',
                Mensagem = CAST(CONCAT(PacienteNome, N' não compareceu à consulta', DataTexto, N'.') AS NVARCHAR(500)),
                DadosJson = CAST(CONCAT(N'{"tipo":"paciente_ausente","consultaId":', ConsultaId, N'}') AS NVARCHAR(MAX)),
                ReferenciaId = ConsultaId
            FROM Base
        )
        INSERT INTO dbo.FilaNotificacoes
            (UsuarioTipo, UsuarioId, Canal, Tipo, Titulo, Mensagem, DadosJson, ReferenciaId, UsuarioRegistro)
        SELECT
            UsuarioTipo,
            UsuarioId,
            N'push',
            Tipo,
            Titulo,
            Mensagem,
            DadosJson,
            ReferenciaId,
            N'Sistema:SP_MarcarNoShow'
        FROM Destinos;

        ;WITH Base AS (
            SELECT
                a.ConsultaId,
                a.PacienteId,
                a.FisioterapeutaId,
                DataTexto = CASE
                    WHEN a.DataHora IS NULL THEN N''
                    ELSE CONCAT(N' de ', CONVERT(NVARCHAR(10), a.DataHora, 103), N' às ', LEFT(CONVERT(NVARCHAR(8), CAST(a.DataHora AS time), 108), 5))
                END,
                PacienteNome = COALESCE(p.Nome, N'O paciente')
            FROM #Atualizadas a
            LEFT JOIN dbo.Pacientes p ON p.Id = a.PacienteId
        ),
        Destinos AS (
            SELECT
                UsuarioTipo = N'Paciente',
                UsuarioId = PacienteId,
                Tipo = N'Agendamento',
                Titulo = N'Falta registrada',
                Mensagem = CAST(CONCAT(
                    N'Você consta como ausente na consulta', DataTexto, N'.',
                    CHAR(13), CHAR(10), CHAR(13), CHAR(10),
                    N'**Caso tenha ocorrido um erro no registro da sua falta, você tem até 24 horas para abrir uma revisão operacional diretamente no aplicativo.**',
                    CHAR(13), CHAR(10), CHAR(13), CHAR(10),
                    N'Após esse prazo, a situação continuará sujeita às regras de ausência previstas nos Termos de Uso da plataforma.'
                ) AS NVARCHAR(500)),
                DadosJson = CAST(CONCAT(N'{"tipo":"paciente_ausente","consultaId":', ConsultaId, N'}') AS NVARCHAR(MAX)),
                ReferenciaId = ConsultaId
            FROM Base
            UNION ALL
            SELECT
                UsuarioTipo = N'Fisioterapeuta',
                UsuarioId = FisioterapeutaId,
                Tipo = N'Agendamento',
                Titulo = N'Paciente ausente',
                Mensagem = CAST(CONCAT(PacienteNome, N' não compareceu à consulta', DataTexto, N'.') AS NVARCHAR(500)),
                DadosJson = CAST(CONCAT(N'{"tipo":"paciente_ausente","consultaId":', ConsultaId, N'}') AS NVARCHAR(MAX)),
                ReferenciaId = ConsultaId
            FROM Base
        )
        INSERT INTO dbo.FilaNotificacoes
            (UsuarioTipo, UsuarioId, Canal, Tipo, Titulo, Mensagem, DadosJson, ReferenciaId, UsuarioRegistro)
        SELECT
            UsuarioTipo,
            UsuarioId,
            N'email',
            Tipo,
            Titulo,
            Mensagem,
            DadosJson,
            ReferenciaId,
            N'Sistema:SP_MarcarNoShow'
        FROM Destinos;

        ;WITH Base AS (
            SELECT
                a.ConsultaId,
                a.PacienteId,
                a.FisioterapeutaId,
                DataTexto = CASE
                    WHEN a.DataHora IS NULL THEN N''
                    ELSE CONCAT(N' de ', CONVERT(NVARCHAR(10), a.DataHora, 103), N' às ', LEFT(CONVERT(NVARCHAR(8), CAST(a.DataHora AS time), 108), 5))
                END,
                PacienteNome = COALESCE(p.Nome, N'O paciente')
            FROM #Atualizadas a
            LEFT JOIN dbo.Pacientes p ON p.Id = a.PacienteId
        ),
        Destinos AS (
            SELECT
                UsuarioTipo = N'Paciente',
                UsuarioId = PacienteId,
                Tipo = N'Agendamento',
                Mensagem = CAST(CONCAT(N'Você consta como ausente na consulta', DataTexto, N'.') AS NVARCHAR(255)),
                ReferenciaId = ConsultaId
            FROM Base
            UNION ALL
            SELECT
                UsuarioTipo = N'Fisioterapeuta',
                UsuarioId = FisioterapeutaId,
                Tipo = N'Agendamento',
                Mensagem = CAST(CONCAT(PacienteNome, N' não compareceu à consulta', DataTexto, N'.') AS NVARCHAR(255)),
                ReferenciaId = ConsultaId
            FROM Base
        )
        INSERT INTO dbo.Notificacoes
            (UsuarioTipo, UsuarioId, Tipo, Mensagem, Lida, DataEnvio, ReferenciaId)
        SELECT
            UsuarioTipo,
            UsuarioId,
            Tipo,
            Mensagem,
            0,
            @Agora,
            ReferenciaId
        FROM Destinos;
        END TRY
        BEGIN CATCH
            INSERT INTO dbo.AuditoriaTriggersLogs
                (TabelaAfetada, Acao, RegistroId, UsuarioSistema, MensagemDetalhe)
            VALUES
                (N'dbo.Notificacoes', N'WARN - SP_MarcarNoShow notificacoes', NULL, SUSER_SNAME(), ERROR_MESSAGE());
        END CATCH;

    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();

        INSERT INTO dbo.AuditoriaTriggersLogs
            (TabelaAfetada, Acao, RegistroId, UsuarioSistema, MensagemDetalhe)
        VALUES
            (N'dbo.Consultas', N'ERRO - SP_MarcarNoShow', NULL, SUSER_SNAME(), @Err);

        RAISERROR(@Err, 16, 1);
    END CATCH
END;
GO
/****** Object:  StoredProcedure [dbo].[SP_MarcarNoShowFisioterapeuta]    Script Date: 22/06/2026 10:02:10 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_MarcarNoShowFisioterapeuta]
    @JanelaMinutos INT = 10,
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
        ---------------------------------------------------------------------
        -- 0) Contexto Admin (se existir RLS)
        ---------------------------------------------------------------------
        DECLARE @CtxTipo NVARCHAR(40) = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40));
        DECLARE @CtxId   INT          = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));
        DECLARE @AdminId INT;

        IF (@CtxTipo IS NULL OR @CtxTipo <> N'Admin' OR @CtxId IS NULL)
        BEGIN
            SELECT TOP (1) @AdminId = Id
            FROM dbo.Administradores
            WHERE Ativo = 1
            ORDER BY Id;

            IF @AdminId IS NOT NULL
            BEGIN
                EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin';
                EXEC sys.sp_set_session_context @key = N'UsuarioId',   @value = @AdminId;
            END
        END

        ---------------------------------------------------------------------
        -- 1) Alvos: passou DataHora + @JanelaMinutos e nao tem CheckinHora
        ---------------------------------------------------------------------
        IF (@JanelaMinutos IS NULL OR @JanelaMinutos <= 0 OR @JanelaMinutos > 240)
            RAISERROR(N'@JanelaMinutos inválido (1..240).', 16, 1);

        IF OBJECT_ID('tempdb..#Alvos') IS NOT NULL DROP TABLE #Alvos;
        CREATE TABLE #Alvos (
            ConsultaId INT NOT NULL,
            PacienteId INT NOT NULL,
            DataHora   DATETIME NOT NULL,
            PRIMARY KEY (ConsultaId)
        );

        INSERT INTO #Alvos (ConsultaId, PacienteId, DataHora)
        SELECT
            c.Id,
            c.PacienteId,
            c.DataHora
        FROM dbo.Consultas c
        WHERE c.DataHora IS NOT NULL
          AND c.CheckinHora IS NULL
          AND LTRIM(RTRIM(ISNULL(c.Status, N''))) IN (N'Confirmada', N'Fisioterapeuta Ausente')
          AND @Agora >= DATEADD(MINUTE, @JanelaMinutos, CAST(c.DataHora AS datetime2(7)));

        IF NOT EXISTS (SELECT 1 FROM #Alvos)
            RETURN;

        BEGIN TRAN;

        ---------------------------------------------------------------------
        -- 2) Marca status = 'Fisioterapeuta Ausente' somente nas Confirmadas
        ---------------------------------------------------------------------
        IF OBJECT_ID('tempdb..#Atualizadas') IS NOT NULL DROP TABLE #Atualizadas;
        CREATE TABLE #Atualizadas (
            ConsultaId INT NOT NULL PRIMARY KEY,
            PacienteId INT NOT NULL,
            FisioterapeutaId INT NOT NULL,
            DataHora DATETIME NOT NULL
        );

        UPDATE c
           SET c.Status = N'Fisioterapeuta Ausente',
               c.ChatLiberado = 0,
               c.DataEncerramento = ISNULL(c.DataEncerramento, CONVERT(datetime, @Agora)),
               c.MotivoEncerramento = ISNULL(
                   c.MotivoEncerramento,
                   CONCAT(N'No-show do fisioterapeuta: sem check-in até ', @JanelaMinutos, N' minuto(s) após o horário agendado.')
               )
        OUTPUT inserted.Id, inserted.PacienteId, inserted.FisioterapeutaId, inserted.DataHora
        INTO #Atualizadas (ConsultaId, PacienteId, FisioterapeutaId, DataHora)
        FROM dbo.Consultas c
        JOIN #Alvos a ON a.ConsultaId = c.Id
        -- Revalida o status no UPDATE: protege contra execucao concorrente do job.
        WHERE LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Confirmada'
          AND c.CheckinHora IS NULL;

        UPDATE ca
           SET ca.Ativo = 0
        FROM dbo.ChatsAtivos ca
        JOIN #Alvos a ON a.ConsultaId = ca.ConsultaId
        WHERE ca.Ativo = 1;

        INSERT INTO dbo.ConsultasLogs (ConsultaId, Evento, Descricao, UsuarioTipo, UsuarioId)
        SELECT
            u.ConsultaId,
            N'NoShowFisioterapeuta',
            CONCAT(N'Fisioterapeuta não realizou check-in até ', @JanelaMinutos, N' minuto(s) após o horário agendado.'),
            N'Sistema',
            NULL
        FROM #Atualizadas u;

        COMMIT;

        ---------------------------------------------------------------------
        -- 3) Notificacoes: fila push + fila email + inbox in-app unico
        ---------------------------------------------------------------------
        IF EXISTS (SELECT 1 FROM #Atualizadas)
        BEGIN
            BEGIN TRY
            ;WITH Base AS (
                SELECT
                    a.ConsultaId,
                    a.PacienteId,
                    a.FisioterapeutaId,
                    DataTexto = CONCAT(N' de ', CONVERT(NVARCHAR(10), a.DataHora, 103), N' às ', LEFT(CONVERT(NVARCHAR(8), CAST(a.DataHora AS time), 108), 5)),
                    FisioNome = COALESCE(f.Nome, N'O fisioterapeuta')
                FROM #Atualizadas a
                LEFT JOIN dbo.Fisioterapeutas f ON f.Id = a.FisioterapeutaId
            ),
            Destinos AS (
                SELECT
                    UsuarioTipo = N'Paciente',
                    UsuarioId = PacienteId,
                    Tipo = N'Agendamento',
                    Titulo = N'Fisioterapeuta ausente',
                    Mensagem = CAST(CONCAT(FisioNome, N' não compareceu à consulta', DataTexto, N'. Escolha como prosseguir.') AS NVARCHAR(500)),
                    DadosJson = CAST(CONCAT(N'{"tipo":"fisioterapeuta_ausente","consultaId":', ConsultaId, N'}') AS NVARCHAR(MAX)),
                    ReferenciaId = ConsultaId
                FROM Base
            )
            INSERT INTO dbo.FilaNotificacoes
                (UsuarioTipo, UsuarioId, Canal, Tipo, Titulo, Mensagem, DadosJson, ReferenciaId, UsuarioRegistro)
            SELECT
                UsuarioTipo,
                UsuarioId,
                N'push',
                Tipo,
                Titulo,
                Mensagem,
                DadosJson,
                ReferenciaId,
                N'Sistema:SP_MarcarNoShowFisioterapeuta'
            FROM Destinos;

            ;WITH Base AS (
                SELECT
                    a.ConsultaId,
                    a.PacienteId,
                    a.FisioterapeutaId,
                    DataTexto = CONCAT(N' para ', CONVERT(NVARCHAR(10), a.DataHora, 103), N' às ', LEFT(CONVERT(NVARCHAR(8), CAST(a.DataHora AS time), 108), 5)),
                    FisioNome = COALESCE(f.Nome, N'O fisioterapeuta')
                FROM #Atualizadas a
                LEFT JOIN dbo.Fisioterapeutas f ON f.Id = a.FisioterapeutaId
            ),
            Destinos AS (
                SELECT
                    UsuarioTipo = N'Paciente',
                    UsuarioId = PacienteId,
                    Tipo = N'Agendamento',
                    Titulo = N'Fisioterapeuta ausente',
                    Mensagem = CAST(CONCAT(
                        FisioNome, N' não realizou o comparecimento ou check-in da consulta agendada', DataTexto, N'.',
                        CHAR(13), CHAR(10), CHAR(13), CHAR(10),
                        N'Abra a consulta no aplicativo para escolher uma alternativa:',
                        CHAR(13), CHAR(10), CHAR(13), CHAR(10),
                        N'1. Reagendar sem custo adicional.',
                        CHAR(13), CHAR(10),
                        N'2. Solicitar reembolso conforme regras e meio de pagamento.',
                        CHAR(13), CHAR(10),
                        N'3. Solicitar crédito futuro na plataforma, quando disponível.'
                    ) AS NVARCHAR(500)),
                    DadosJson = CAST(CONCAT(N'{"tipo":"fisioterapeuta_ausente","consultaId":', ConsultaId, N'}') AS NVARCHAR(MAX)),
                    ReferenciaId = ConsultaId
                FROM Base
            )
            INSERT INTO dbo.FilaNotificacoes
                (UsuarioTipo, UsuarioId, Canal, Tipo, Titulo, Mensagem, DadosJson, ReferenciaId, UsuarioRegistro)
            SELECT
                UsuarioTipo,
                UsuarioId,
                N'email',
                Tipo,
                Titulo,
                Mensagem,
                DadosJson,
                ReferenciaId,
                N'Sistema:SP_MarcarNoShowFisioterapeuta'
            FROM Destinos;

            ;WITH Base AS (
                SELECT
                    a.ConsultaId,
                    a.PacienteId,
                    a.FisioterapeutaId,
                    DataTexto = CONCAT(N' de ', CONVERT(NVARCHAR(10), a.DataHora, 103), N' às ', LEFT(CONVERT(NVARCHAR(8), CAST(a.DataHora AS time), 108), 5)),
                    FisioNome = COALESCE(f.Nome, N'O fisioterapeuta')
                FROM #Atualizadas a
                LEFT JOIN dbo.Fisioterapeutas f ON f.Id = a.FisioterapeutaId
            )
            INSERT INTO dbo.Notificacoes
                (UsuarioTipo, UsuarioId, Tipo, Mensagem, Lida, DataEnvio, ReferenciaId)
            SELECT
                N'Paciente',
                PacienteId,
                N'Agendamento',
                CAST(CONCAT(FisioNome, N' não compareceu à consulta', DataTexto, N'. Escolha como prosseguir.') AS NVARCHAR(255)),
                0,
                @Agora,
                ConsultaId
            FROM Base;
            END TRY
            BEGIN CATCH
                INSERT INTO dbo.AuditoriaTriggersLogs
                    (TabelaAfetada, Acao, RegistroId, UsuarioSistema, MensagemDetalhe)
                VALUES
                    (N'dbo.Notificacoes', N'WARN - SP_MarcarNoShowFisioterapeuta notificacoes', NULL, SUSER_SNAME(), ERROR_MESSAGE());
            END CATCH;
        END
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;

        DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();

        INSERT INTO dbo.AuditoriaTriggersLogs
            (TabelaAfetada, Acao, RegistroId, UsuarioSistema, MensagemDetalhe)
        VALUES
            (N'dbo.Consultas', N'ERRO - SP_MarcarNoShowFisioterapeuta', NULL, SUSER_SNAME(), @Err);

        RAISERROR(@Err, 16, 1);
    END CATCH
END;
GO
/****** Object:  StoredProcedure [dbo].[ProcessarFilaAtualizacaoPontos]    Script Date: 22/06/2026 10:02:10 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[ProcessarFilaAtualizacaoPontos]
    @BatchSize INT = 500,
    @FalharEmErro BIT = 0,
    @LockTimeoutMs INT = 15000,     -- 15s (opcional)
    @MaxLoops INT = 20000,          -- guard anti-loop
    @AgoraBrasil DATETIME2(7) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @Agora DATETIME2(7) = COALESCE(
        @AgoraBrasil,
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7))
    );

    ------------------------------------------------------------
    -- 0) Lock timeout (via dynamic SQL para evitar erro de sintaxe)
    ------------------------------------------------------------
    IF (@LockTimeoutMs IS NOT NULL AND @LockTimeoutMs >= 0)
    BEGIN
        DECLARE @sqlLock NVARCHAR(100) =
            N'SET LOCK_TIMEOUT ' + CONVERT(NVARCHAR(20), @LockTimeoutMs) + N';';
        EXEC (@sqlLock);
    END

    ------------------------------------------------------------
    -- Variáveis
    ------------------------------------------------------------
    DECLARE
        @Total INT = 0,
        @Loops INT = 0,
        @Inicio DATETIME2(7) = @Agora,
        @UsuarioExecucao NVARCHAR(200) = SUSER_SNAME(),
        @OriginalLogin   NVARCHAR(200) = ORIGINAL_LOGIN(),
        @Programa        NVARCHAR(200) = PROGRAM_NAME(),
        @CtxTipo NVARCHAR(40),
        @CtxId INT,
        @AdminId INT,
        @ReadOnly BIT = 0;

    BEGIN TRY
        ------------------------------------------------------------
        -- 1) Contexto Admin (bypass RLS)
        ------------------------------------------------------------
        SELECT
            @CtxTipo = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)),
            @CtxId   = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));

        SELECT TOP (1) @AdminId = Id
        FROM dbo.Administradores
        WHERE Ativo = 1
        ORDER BY Id;

        IF @AdminId IS NULL
            THROW 51001, 'Nenhum Administrador Ativo encontrado para setar contexto Admin.', 1;

        IF (@UsuarioExecucao = N'NT SERVICE\SQLSERVERAGENT' OR @Programa LIKE N'SQLAgent%')
            SET @ReadOnly = 1;

        IF (@CtxTipo IS NULL OR @CtxId IS NULL)
        BEGIN
            EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin', @read_only = @ReadOnly;
            EXEC sys.sp_set_session_context @key = N'UsuarioId',   @value = @AdminId,  @read_only = @ReadOnly;
        END

        ------------------------------------------------------------
        -- 2) Processamento em lotes
        ------------------------------------------------------------
        WHILE 1 = 1
        BEGIN
            SET @Loops += 1;
            IF (@Loops > @MaxLoops)
                THROW 51010, 'Guard: loop excedeu limite. Verifique concorrência/bloqueios.', 1;

            BEGIN TRAN;

            DECLARE @Lote TABLE (
                Id INT PRIMARY KEY,
                ConsultaId INT,
                FisioId INT,
                Pontos INT
            );

            ;WITH cte AS
            (
                SELECT TOP (@BatchSize)
                    f.Id,
                    f.ConsultaId,
                    f.FisioterapeutaId,
                    f.PontosGanhos,
                    f.StatusProcessamento,
                    f.DataRegistro
                FROM dbo.FilaAtualizacaoPontos f WITH (READPAST, UPDLOCK, ROWLOCK)
                WHERE f.StatusProcessamento = N'Pendente'
                ORDER BY f.DataRegistro, f.Id
            )
            UPDATE cte
            SET StatusProcessamento = N'Processando'
            OUTPUT
                inserted.Id,
                inserted.ConsultaId,
                inserted.FisioterapeutaId,
                inserted.PontosGanhos
            INTO @Lote (Id, ConsultaId, FisioId, Pontos);

            IF (@@ROWCOUNT = 0 OR NOT EXISTS (SELECT 1 FROM @Lote))
            BEGIN
                COMMIT;
                BREAK;
            END

            ;WITH Soma AS (
                SELECT FisioId, SUM(Pontos) AS PontosSomados
                FROM @Lote
                GROUP BY FisioId
            )
            UPDATE f
            SET f.Pontos = ISNULL(f.Pontos, 0) + s.PontosSomados
            FROM dbo.Fisioterapeutas f
            JOIN Soma s ON s.FisioId = f.Id;

            UPDATE fila
            SET fila.StatusProcessamento = N'Processado',
                fila.DataProcessamento = @Agora
            FROM dbo.FilaAtualizacaoPontos fila
            JOIN @Lote l ON l.Id = fila.Id
            WHERE fila.StatusProcessamento = N'Processando';

            SET @Total += (SELECT COUNT(*) FROM @Lote);

            COMMIT;
        END

        SELECT @Total AS TotalProcessado;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;

        IF (@FalharEmErro = 1)
            THROW;
        -- Se @FalharEmErro=0, engole o erro (igual seu padrão atual)
    END CATCH
END;
GO
SELECT
    CAST(1 AS BIT) AS Sucesso,
    N'AZURE_TIMEZONE_JOBS_V117 aplicado. SPs de jobs passam a aceitar @AgoraBrasil/fallback Sao Paulo.' AS Mensagem;
GO
