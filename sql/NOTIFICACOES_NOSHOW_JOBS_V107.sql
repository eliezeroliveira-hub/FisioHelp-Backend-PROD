SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

/*
  NOTIFICACOES_NOSHOW_JOBS_V107
  Enfileira notificacoes push/in-app nos jobs SQL que marcam no-show:
  - dbo.SP_MarcarNoShow              -> Paciente Ausente
  - dbo.SP_MarcarNoShowFisioterapeuta -> Fisioterapeuta Ausente

  Dependencias:
  - NOTIFICACOES_PUSH_SCHEMA_V105 aplicado.
  - NOTIFICACOES_TIPOS_V106 aplicado.
*/

CREATE OR ALTER PROCEDURE [dbo].[SP_MarcarNoShow]
    @JanelaMinutos INT = 10
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

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
          AND DATEDIFF(MINUTE, c.CheckinHora, SYSDATETIME()) >= @JanelaMinutos
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
               c.DataEncerramento = ISNULL(c.DataEncerramento, CONVERT(datetime, SYSDATETIME())),
               c.MotivoEncerramento = ISNULL(
                    c.MotivoEncerramento,
                    CONCAT(N'Paciente não confirmou token em até ', @JanelaMinutos, N' minuto(s) após o check-in.')
               )
        OUTPUT inserted.Id, inserted.PacienteId, inserted.FisioterapeutaId, inserted.DataHora
        INTO #Atualizadas (ConsultaId, PacienteId, FisioterapeutaId, DataHora)
        FROM dbo.Consultas c
        JOIN #Alvos a ON a.Id = c.Id
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
        -- 5) Notificacoes: fila push + inbox in-app
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
            GETDATE(),
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

CREATE OR ALTER PROCEDURE [dbo].[SP_MarcarNoShowFisioterapeuta]
    @JanelaMinutos INT = 10
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

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
          AND SYSDATETIME() >= DATEADD(MINUTE, @JanelaMinutos, CAST(c.DataHora AS datetime2(7)));

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
               c.DataEncerramento = ISNULL(c.DataEncerramento, CONVERT(datetime, SYSDATETIME())),
               c.MotivoEncerramento = ISNULL(
                   c.MotivoEncerramento,
                   CONCAT(N'No-show do fisioterapeuta: sem check-in até ', @JanelaMinutos, N' minuto(s) após o horário agendado.')
               )
        OUTPUT inserted.Id, inserted.PacienteId, inserted.FisioterapeutaId, inserted.DataHora
        INTO #Atualizadas (ConsultaId, PacienteId, FisioterapeutaId, DataHora)
        FROM dbo.Consultas c
        JOIN #Alvos a ON a.ConsultaId = c.Id
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
        -- 3) Notificacoes: fila push + inbox in-app
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
                GETDATE(),
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

SELECT
    CAST(1 AS bit) AS Sucesso,
    N'NOTIFICACOES_NOSHOW_JOBS_V107 aplicado. Jobs de no-show passam a enfileirar notificacoes.' AS Mensagem;
GO
