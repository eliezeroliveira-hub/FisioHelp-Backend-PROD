SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE OR ALTER PROCEDURE [dbo].[SP_VerificarConsultasExpiradas]
    @HorasSemConfirmacao INT = 2,
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
        IF @HorasSemConfirmacao < 1
            THROW 51309, 'A antecedencia para cancelamento deve ser maior que zero.', 1;

        -----------------------------------------------------------------
        -- 0) Contexto Admin (bypass RLS) para execucao por Job/SQL Agent
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
        -- 1) Alvos: consultas Aguardando ao atingir a antecedencia configurada.
        --    O nome do parametro e mantido por compatibilidade com o Job.
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
            PagoComCreditoCarteira BIT NOT NULL,
            ReembolsoExterno       BIT NOT NULL,
            TransacaoId            INT NULL,
            GatewayPaymentId       NVARCHAR(100) NULL,
            TransacaoValor         DECIMAL(10,2) NULL,
            GatewayRefundStatus    NVARCHAR(60) NULL
        );

        BEGIN TRAN;

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
            PagoComCreditoCarteira,
            ReembolsoExterno,
            TransacaoId,
            GatewayPaymentId,
            TransacaoValor,
            GatewayRefundStatus
        )
        SELECT
            c.Id,
            c.PacienteId,
            c.FisioterapeutaId,
            dados.StatusPagamento,
            ISNULL(c.ValorConsulta, 0),
            ISNULL(c.PagamentoViaPlataforma, 1),
            dados.OrigemPagamento,
            forma.PagoComPacote,
            forma.PagoComCreditoCarteira,
            CAST(
                CASE
                    WHEN forma.PagoComPacote = 0
                     AND forma.PagoComCreditoCarteira = 0
                     AND dados.StatusPagamento = N'Pago'
                     AND ISNULL(c.ValorConsulta, 0) > 0
                     AND dados.OrigemPagamento NOT IN (N'Carteira', N'Pacote')
                     AND (
                         ISNULL(c.PagamentoViaPlataforma, 1) = 1
                         OR dados.OrigemPagamento = N'Plataforma'
                     )
                    THEN 1 ELSE 0
                END
            AS BIT),
            tx.TransacaoId,
            tx.GatewayPaymentId,
            tx.TransacaoValor,
            tx.GatewayRefundStatus
        FROM dbo.Consultas c WITH (UPDLOCK, HOLDLOCK)
        CROSS APPLY
        (
            SELECT
                LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))) AS StatusPagamento,
                LTRIM(RTRIM(ISNULL(c.OrigemPagamento, N''))) AS OrigemPagamento
        ) dados
        CROSS APPLY
        (
            SELECT
                CAST(
                    CASE
                        WHEN EXISTS (
                            SELECT 1
                            FROM dbo.CreditosPacientes cp WITH (UPDLOCK, HOLDLOCK)
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
                            FROM dbo.CreditosPacientes cp WITH (UPDLOCK, HOLDLOCK)
                            WHERE cp.ConsultaId = c.Id
                              AND cp.PacienteId = c.PacienteId
                              AND cp.PacoteId IS NULL
                        )
                        THEN 1 ELSE 0
                    END
                AS BIT) AS PagoComCreditoCarteira
        ) forma
        OUTER APPLY
        (
            SELECT TOP (1)
                t.Id                  AS TransacaoId,
                t.GatewayPaymentId,
                t.ValorTotal          AS TransacaoValor,
                LTRIM(RTRIM(ISNULL(t.GatewayRefundStatus, N''))) AS GatewayRefundStatus
            FROM dbo.Transacoes t WITH (UPDLOCK, HOLDLOCK)
            WHERE t.ConsultaId = c.Id
              AND t.PacienteId = c.PacienteId
              AND LTRIM(RTRIM(ISNULL(t.Status, N''))) IN (N'Pago', N'Reembolsado')
              AND LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N''))) NOT IN (N'Pacote', N'CreditoCarteira')
            ORDER BY t.Id DESC
        ) tx
        WHERE LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Aguardando'
          AND ISNULL(c.ConfirmacaoAutomatica, 0) = 0
          AND @Agora >= DATEADD(HOUR, -@HorasSemConfirmacao, c.DataHora);

        IF NOT EXISTS (SELECT 1 FROM @Alvos)
        BEGIN
            COMMIT;
            RETURN;
        END

        -----------------------------------------------------------------
        -- 2) Validacoes financeiras antes de cancelar qualquer consulta.
        -----------------------------------------------------------------
        IF EXISTS
        (
            SELECT 1
            FROM @Alvos
            WHERE StatusPagamento = N'Pago'
              AND Valor > 0
              AND PagoComPacote = 0
              AND PagoComCreditoCarteira = 0
              AND OrigemPagamento IN (N'Carteira', N'Pacote')
        )
            THROW 51310, 'Pagamento interno sem credito ou pacote vinculado. Cancelamento automatico interrompido.', 1;

        IF EXISTS (SELECT 1 FROM @Alvos WHERE ReembolsoExterno = 1)
           AND OBJECT_ID(N'dbo.FilaReembolsosGateway', N'U') IS NULL
            THROW 51311, 'FilaReembolsosGateway nao existe. Cancelamento automatico interrompido.', 1;

        IF EXISTS
        (
            SELECT 1
            FROM @Alvos
            WHERE ReembolsoExterno = 1
              AND (
                  TransacaoId IS NULL
                  OR TransacaoValor IS NULL
                  OR TransacaoValor <= 0
                  OR (
                      GatewayRefundStatus <> N'DONE'
                      AND NULLIF(LTRIM(RTRIM(GatewayPaymentId)), N'') IS NULL
                  )
              )
        )
            THROW 51312, 'Pagamento externo sem transacao valida ou GatewayPaymentId. Cancelamento automatico interrompido.', 1;

        DECLARE @MotivoMaxBytes INT = COL_LENGTH('dbo.CreditosPacientes', 'Motivo');
        DECLARE @MotivoMaxChars INT =
            CASE
                WHEN @MotivoMaxBytes IS NULL OR @MotivoMaxBytes <= 0 THEN 400
                ELSE (@MotivoMaxBytes / 2)
            END;

        -----------------------------------------------------------------
        -- 3) Cancela e encerra a consulta.
        --    Pagamento externo permanece Pago ate o webhook confirmar.
        -----------------------------------------------------------------
        UPDATE c
           SET c.Status             = N'Cancelada',
               c.ChatLiberado       = 0,
               c.ChatLiberadoEm     = NULL,
               c.DataEncerramento   = ISNULL(c.DataEncerramento, @Agora),
               c.MotivoEncerramento = ISNULL(
                   c.MotivoEncerramento,
                   CONCAT(
                       N'Cancelamento automatico por falta de confirmacao ao atingir ',
                       @HorasSemConfirmacao,
                       N'h de antecedencia do horario agendado.'
                   )
               ),
               c.StatusPagamento =
                   CASE
                       WHEN a.PagoComPacote = 1 OR a.PagoComCreditoCarteira = 1
                           THEN N'CreditoPaciente'
                       WHEN a.ReembolsoExterno = 1 AND a.GatewayRefundStatus = N'DONE'
                           THEN N'Reembolsado'
                       ELSE c.StatusPagamento
                   END
        FROM dbo.Consultas c
        INNER JOIN @Alvos a ON a.ConsultaId = c.Id
        WHERE LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Aguardando';

        -----------------------------------------------------------------
        -- 4) Inativa chats ativos da consulta.
        -----------------------------------------------------------------
        UPDATE ca
           SET ca.Ativo = 0
        FROM dbo.ChatsAtivos ca
        INNER JOIN @Alvos a ON a.ConsultaId = ca.ConsultaId
        WHERE ca.Ativo = 1;

        -----------------------------------------------------------------
        -- 5) Pago com pacote: devolve a sessao ao pacote.
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
                       N'Cancelamento automatico por falta de confirmacao ao atingir ',
                       @HorasSemConfirmacao,
                       N'h de antecedencia do horario agendado.'
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
        -- 6) Pago com credito na carteira: reativa o credito existente.
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
                       N'Cancelamento automatico por falta de confirmacao ao atingir ',
                       @HorasSemConfirmacao,
                       N'h de antecedencia do horario agendado.'
                   ),
                   @MotivoMaxChars
               )
        FROM dbo.CreditosPacientes cp WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN @Alvos a
            ON a.ConsultaId = cp.ConsultaId
           AND a.PacienteId = cp.PacienteId
        WHERE a.PagoComCreditoCarteira = 1
          AND cp.PacoteId IS NULL
          AND cp.Status = N'Usado';

        -----------------------------------------------------------------
        -- 7) Pago externamente: enfileira estorno no gateway.
        --    Nao cria credito interno para pagamento em cartao/Pix.
        -----------------------------------------------------------------
        DECLARE @FilasReembolso TABLE
        (
            TransacaoId INT PRIMARY KEY,
            FilaId      INT NOT NULL
        );

        INSERT INTO @FilasReembolso (TransacaoId, FilaId)
        SELECT DISTINCT a.TransacaoId, fila.Id
        FROM @Alvos a
        CROSS APPLY
        (
            SELECT TOP (1) fr.Id
            FROM dbo.FilaReembolsosGateway fr WITH (UPDLOCK, HOLDLOCK)
            WHERE fr.TransacaoId = a.TransacaoId
              AND fr.Status IN (N'Pendente', N'Processando', N'Solicitado', N'FalhaTemporaria', N'Parcial')
            ORDER BY fr.Id DESC
        ) fila
        WHERE a.ReembolsoExterno = 1
          AND a.GatewayRefundStatus <> N'DONE';

        UPDATE fr
           SET fr.ConsultaId = COALESCE(fr.ConsultaId, a.ConsultaId),
               fr.GatewayPaymentId = COALESCE(fr.GatewayPaymentId, a.GatewayPaymentId),
               fr.Valor = COALESCE(fr.Valor, a.TransacaoValor),
               fr.Motivo = LEFT(
                   CONCAT(
                       N'Reembolso da consulta ',
                       a.ConsultaId,
                       N' por cancelamento automatico por falta de confirmacao ao atingir ',
                       @HorasSemConfirmacao,
                       N'h de antecedencia do horario agendado.'
                   ),
                   500
               ),
               fr.ProximaTentativaEm = CASE
                   WHEN fr.Status IN (N'Pendente', N'FalhaTemporaria')
                       THEN COALESCE(fr.ProximaTentativaEm, @Agora)
                   ELSE fr.ProximaTentativaEm
               END,
               fr.AtualizadoEm = @Agora
        FROM dbo.FilaReembolsosGateway fr
        INNER JOIN @FilasReembolso existente ON existente.FilaId = fr.Id
        INNER JOIN @Alvos a ON a.TransacaoId = existente.TransacaoId;

        INSERT INTO dbo.FilaReembolsosGateway
        (
            TransacaoId,
            ConsultaId,
            Origem,
            Provider,
            GatewayPaymentId,
            Valor,
            Motivo,
            Status,
            Tentativas,
            ProximaTentativaEm,
            CriadoEm,
            AtualizadoEm,
            UsuarioRegistro
        )
        SELECT
            a.TransacaoId,
            a.ConsultaId,
            N'Admin',
            N'asaas',
            a.GatewayPaymentId,
            a.TransacaoValor,
            LEFT(
                CONCAT(
                    N'Reembolso da consulta ',
                    a.ConsultaId,
                    N' por cancelamento automatico por falta de confirmacao ao atingir ',
                    @HorasSemConfirmacao,
                    N'h de antecedencia do horario agendado.'
                ),
                500
            ),
            N'Pendente',
            0,
            @Agora,
            @Agora,
            @Agora,
            N'Sistema:SP_VerificarConsultasExpiradas'
        FROM @Alvos a
        WHERE a.ReembolsoExterno = 1
          AND a.GatewayRefundStatus <> N'DONE'
          AND NOT EXISTS
          (
              SELECT 1
              FROM @FilasReembolso existente
              WHERE existente.TransacaoId = a.TransacaoId
          );

        UPDATE t
           SET t.Status = CASE
                   WHEN LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Reembolsado'
                    AND LTRIM(RTRIM(ISNULL(t.GatewayRefundStatus, N''))) <> N'DONE'
                       THEN N'Pago'
                   ELSE t.Status
               END,
               t.GatewayProvider = COALESCE(t.GatewayProvider, N'asaas'),
               t.GatewayPaymentId = COALESCE(t.GatewayPaymentId, a.GatewayPaymentId),
               t.GatewayRefundStatus = N'QUEUED',
               t.GatewayRefundValor = COALESCE(t.GatewayRefundValor, a.TransacaoValor),
               t.GatewayRefundDescricao = LEFT(
                   CONCAT(
                       N'Reembolso da consulta ',
                       a.ConsultaId,
                       N' por cancelamento automatico por falta de confirmacao ao atingir ',
                       @HorasSemConfirmacao,
                       N'h de antecedencia do horario agendado.'
                   ),
                   500
               ),
               t.GatewayUltimoEvento = N'FISIOHELP_REFUND_QUEUED',
               t.GatewayAtualizadoEm = @Agora,
               t.GatewayErroMensagem = NULL
        FROM dbo.Transacoes t
        INNER JOIN @Alvos a ON a.TransacaoId = t.Id
        WHERE a.ReembolsoExterno = 1
          AND a.GatewayRefundStatus <> N'DONE';

        -----------------------------------------------------------------
        -- 8) Logs.
        -----------------------------------------------------------------
        INSERT INTO dbo.ConsultasLogs
            (ConsultaId, Evento, Descricao, UsuarioTipo, UsuarioId)
        SELECT
            a.ConsultaId,
            N'CancelamentoAutomatico',
            CONCAT(
                N'Consulta cancelada automaticamente por falta de confirmacao ao atingir ',
                @HorasSemConfirmacao,
                N'h de antecedencia do horario agendado.',
                CASE
                    WHEN a.ReembolsoExterno = 1 AND a.GatewayRefundStatus <> N'DONE'
                        THEN N' Reembolso externo enfileirado.'
                    WHEN a.ReembolsoExterno = 1 AND a.GatewayRefundStatus = N'DONE'
                        THEN N' Reembolso externo ja confirmado.'
                    ELSE N''
                END
            ),
            N'Sistema',
            NULL
        FROM @Alvos a;

        COMMIT;

        PRINT N'OK - Consultas expiradas canceladas. Pacote e credito interno foram restaurados; pagamentos externos foram enfileirados para estorno.';
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
