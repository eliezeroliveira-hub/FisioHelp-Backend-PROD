SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

/*
    V105 - Schema base para notificacoes push

    Escopo:
      - Cria dbo.DispositivosNotificacao
      - Cria dbo.FilaNotificacoes
      - Cria RLS com FILTER predicate nas duas tabelas

    Observacoes:
      - dbo.Notificacoes permanece inalterada; ela continua sendo inbox in-app.
      - O script e idempotente para criacao inicial dos objetos.
      - Nao cria service, worker, provider, procedure de enfileiramento ou FK polimorfica.
*/

IF SCHEMA_ID(N'security') IS NULL
BEGIN
    EXEC(N'CREATE SCHEMA [security]');
END
GO

IF OBJECT_ID(N'[dbo].[DispositivosNotificacao]', N'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[DispositivosNotificacao](
        [Id]                    INT IDENTITY(1,1) NOT NULL,
        [UsuarioTipo]           NVARCHAR(20)  NOT NULL,
        [UsuarioId]             INT           NOT NULL,
        [Plataforma]            NVARCHAR(10)  NOT NULL,
        [TokenPush]             NVARCHAR(512) NOT NULL,
        [Ativo]                 BIT           NOT NULL CONSTRAINT [DF_DispositivosNotificacao_Ativo] DEFAULT (1),
        [CriadoEm]              DATETIME2(7)  NOT NULL CONSTRAINT [DF_DispositivosNotificacao_CriadoEm] DEFAULT (SYSDATETIME()),
        [AtualizadoEm]          DATETIME2(7)  NOT NULL CONSTRAINT [DF_DispositivosNotificacao_AtualizadoEm] DEFAULT (SYSDATETIME()),
        [UsuarioRegistro]       NVARCHAR(200) NULL,
        CONSTRAINT [PK_DispositivosNotificacao] PRIMARY KEY CLUSTERED ([Id] ASC),
        CONSTRAINT [UQ_DispositivosNotificacao_Token] UNIQUE ([TokenPush]),
        CONSTRAINT [CK_DispositivosNotificacao_UsuarioTipo] CHECK ([UsuarioTipo] IN (N'Fisioterapeuta', N'Paciente')),
        CONSTRAINT [CK_DispositivosNotificacao_Plataforma] CHECK ([Plataforma] IN (N'ios', N'android'))
    );
END
GO

IF OBJECT_ID(N'[dbo].[FilaNotificacoes]', N'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[FilaNotificacoes](
        [Id]                  INT IDENTITY(1,1) NOT NULL,
        [UsuarioTipo]         NVARCHAR(20)   NOT NULL,
        [UsuarioId]           INT            NOT NULL,
        [Canal]               NVARCHAR(10)   NOT NULL CONSTRAINT [DF_FilaNotificacoes_Canal] DEFAULT (N'push'),
        [Tipo]                NVARCHAR(30)   NULL,
        [Titulo]              NVARCHAR(120)  NULL,
        [Mensagem]            NVARCHAR(500)  NOT NULL,
        [DadosJson]           NVARCHAR(MAX)  NULL,
        [ReferenciaId]        INT            NULL,
        [Status]              NVARCHAR(20)   NOT NULL CONSTRAINT [DF_FilaNotificacoes_Status] DEFAULT (N'Pendente'),
        [Tentativas]          INT            NOT NULL CONSTRAINT [DF_FilaNotificacoes_Tentativas] DEFAULT (0),
        [MaxTentativas]       INT            NOT NULL CONSTRAINT [DF_FilaNotificacoes_MaxTentativas] DEFAULT (5),
        [ProximaTentativaEm]  DATETIME2(7)   NULL,
        [ProcessandoEm]       DATETIME2(7)   NULL,
        [EnviadoEm]           DATETIME2(7)   NULL,
        [UltimoErro]          NVARCHAR(500)  NULL,
        [CriadoEm]            DATETIME2(7)   NOT NULL CONSTRAINT [DF_FilaNotificacoes_CriadoEm] DEFAULT (SYSDATETIME()),
        [AtualizadoEm]        DATETIME2(7)   NOT NULL CONSTRAINT [DF_FilaNotificacoes_AtualizadoEm] DEFAULT (SYSDATETIME()),
        [UsuarioRegistro]     NVARCHAR(200)  NULL,
        CONSTRAINT [PK_FilaNotificacoes] PRIMARY KEY CLUSTERED ([Id] ASC),
        CONSTRAINT [CK_FilaNotificacoes_UsuarioTipo] CHECK ([UsuarioTipo] IN (N'Fisioterapeuta', N'Paciente')),
        CONSTRAINT [CK_FilaNotificacoes_Canal] CHECK ([Canal] IN (N'push', N'email')),
        CONSTRAINT [CK_FilaNotificacoes_Tipo] CHECK ([Tipo] IS NULL OR [Tipo] IN (N'Promocao', N'Chat', N'Pagamento', N'Agendamento')),
        CONSTRAINT [CK_FilaNotificacoes_Status] CHECK ([Status] IN (N'Pendente', N'Processando', N'Enviado', N'FalhaTemporaria', N'FalhaDefinitiva')),
        CONSTRAINT [CK_FilaNotificacoes_Tentativas] CHECK ([Tentativas] >= 0),
        CONSTRAINT [CK_FilaNotificacoes_MaxTentativas] CHECK ([MaxTentativas] BETWEEN 1 AND 20),
        CONSTRAINT [CK_FilaNotificacoes_DadosJson] CHECK ([DadosJson] IS NULL OR ISJSON([DadosJson]) = 1)
    );
END
GO

IF OBJECT_ID(N'[dbo].[DispositivosNotificacao]', N'U') IS NOT NULL
   AND NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE [name] = N'IX_DispositivosNotificacao_Usuario'
          AND [object_id] = OBJECT_ID(N'[dbo].[DispositivosNotificacao]')
   )
BEGIN
    CREATE INDEX [IX_DispositivosNotificacao_Usuario]
        ON [dbo].[DispositivosNotificacao] ([UsuarioTipo], [UsuarioId], [Ativo]);
END
GO

IF OBJECT_ID(N'[dbo].[FilaNotificacoes]', N'U') IS NOT NULL
   AND NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE [name] = N'IX_FilaNotificacoes_Claim'
          AND [object_id] = OBJECT_ID(N'[dbo].[FilaNotificacoes]')
   )
BEGIN
    CREATE NONCLUSTERED INDEX [IX_FilaNotificacoes_Claim]
        ON [dbo].[FilaNotificacoes] ([Status], [ProximaTentativaEm], [CriadoEm])
        INCLUDE ([Canal], [Tentativas], [MaxTentativas])
        WHERE [Status] IN (N'Pendente', N'FalhaTemporaria');
END
GO

IF OBJECT_ID(N'[dbo].[FilaNotificacoes]', N'U') IS NOT NULL
   AND NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE [name] = N'IX_FilaNotificacoes_ProcessandoEm'
          AND [object_id] = OBJECT_ID(N'[dbo].[FilaNotificacoes]')
   )
BEGIN
    CREATE NONCLUSTERED INDEX [IX_FilaNotificacoes_ProcessandoEm]
        ON [dbo].[FilaNotificacoes] ([Status], [ProcessandoEm])
        INCLUDE ([Tentativas], [MaxTentativas])
        WHERE [Status] = N'Processando';
END
GO

IF OBJECT_ID(N'[security].[fn_rls_filtro_usuario_notif]', N'IF') IS NULL
BEGIN
    EXEC(N'
CREATE FUNCTION [security].[fn_rls_filtro_usuario_notif] (
    @UsuarioTipo NVARCHAR(20),
    @UsuarioId INT
)
RETURNS TABLE
WITH SCHEMABINDING
AS
RETURN
(
    SELECT 1 AS [fn_result]
    WHERE
        SUSER_SNAME() = N''app_backend''
        OR EXISTS (SELECT 1 FROM [security].[fn_rls_is_admin]())
        OR (
            CONVERT(NVARCHAR(20), SESSION_CONTEXT(N''UsuarioTipo'')) IN (N''Paciente'', N''Fisioterapeuta'')
            AND @UsuarioTipo = CONVERT(NVARCHAR(20), SESSION_CONTEXT(N''UsuarioTipo''))
            AND @UsuarioId = TRY_CONVERT(INT, SESSION_CONTEXT(N''UsuarioId''))
        )
);
');
END
GO

IF OBJECT_ID(N'[dbo].[DispositivosNotificacao]', N'U') IS NOT NULL
   AND OBJECT_ID(N'[dbo].[FilaNotificacoes]', N'U') IS NOT NULL
   AND OBJECT_ID(N'[security].[fn_rls_filtro_usuario_notif]', N'IF') IS NOT NULL
   AND NOT EXISTS (
        SELECT 1
        FROM sys.security_policies
        WHERE [name] = N'rls_policy_notificacoes_push'
          AND [schema_id] = SCHEMA_ID(N'security')
   )
BEGIN
    CREATE SECURITY POLICY [security].[rls_policy_notificacoes_push]
        ADD FILTER PREDICATE [security].[fn_rls_filtro_usuario_notif]([UsuarioTipo], [UsuarioId])
            ON [dbo].[DispositivosNotificacao],
        ADD FILTER PREDICATE [security].[fn_rls_filtro_usuario_notif]([UsuarioTipo], [UsuarioId])
            ON [dbo].[FilaNotificacoes]
        WITH (STATE = ON, SCHEMABINDING = ON);
END
GO

SELECT
    CAST(1 AS BIT) AS [Sucesso],
    N'NOTIFICACOES_PUSH_SCHEMA_V105 aplicado. Tabelas DispositivosNotificacao e FilaNotificacoes criadas/validadas sem alterar dbo.Notificacoes.' AS [Mensagem];
GO
