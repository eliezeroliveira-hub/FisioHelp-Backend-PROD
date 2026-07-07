/*
  V125 - Fila transacional de contato para envio assíncrono de códigos.
  Primeira etapa: /auth/senha/esqueci.
*/

SET NOCOUNT ON;

BEGIN TRY
    IF OBJECT_ID(N'dbo.FilaContatoTransacional', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.FilaContatoTransacional
        (
            Id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_FilaContatoTransacional PRIMARY KEY,
            Tipo NVARCHAR(60) NOT NULL,
            Canal NVARCHAR(20) NOT NULL,
            Destino NVARCHAR(255) NOT NULL,
            Assunto NVARCHAR(200) NULL,
            Html NVARCHAR(MAX) NULL,
            Texto NVARCHAR(MAX) NULL,
            PayloadJson NVARCHAR(MAX) NULL,
            Status NVARCHAR(30) NOT NULL CONSTRAINT DF_FilaContatoTransacional_Status DEFAULT (N'Pendente'),
            Tentativas TINYINT NOT NULL CONSTRAINT DF_FilaContatoTransacional_Tentativas DEFAULT (0),
            MaxTentativas TINYINT NOT NULL CONSTRAINT DF_FilaContatoTransacional_MaxTentativas DEFAULT (5),
            ProcessandoEm DATETIME2(7) NULL,
            ProximaTentativaEm DATETIME2(7) NULL,
            ErroMensagem NVARCHAR(500) NULL,
            CriadoEm DATETIME2(7) NOT NULL CONSTRAINT DF_FilaContatoTransacional_CriadoEm DEFAULT (SYSDATETIME()),
            AtualizadoEm DATETIME2(7) NOT NULL CONSTRAINT DF_FilaContatoTransacional_AtualizadoEm DEFAULT (SYSDATETIME()),
            ProcessadoEm DATETIME2(7) NULL,
            UsuarioRegistro NVARCHAR(200) NULL,
            CONSTRAINT CK_FilaContatoTransacional_Canal CHECK (Canal IN (N'Email', N'Telefone')),
            CONSTRAINT CK_FilaContatoTransacional_Status CHECK (Status IN (N'Pendente', N'Processando', N'Processado', N'FalhaTemporaria', N'FalhaPermanente')),
            CONSTRAINT CK_FilaContatoTransacional_MaxTentativas CHECK (MaxTentativas BETWEEN 1 AND 20)
        );
    END;

    IF COL_LENGTH(N'dbo.FilaContatoTransacional', N'UsuarioRegistro') IS NULL
    BEGIN
        ALTER TABLE dbo.FilaContatoTransacional
            ADD UsuarioRegistro NVARCHAR(200) NULL;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE name = N'IX_FilaContatoTransacional_Claim'
          AND object_id = OBJECT_ID(N'dbo.FilaContatoTransacional')
    )
    BEGIN
        CREATE INDEX IX_FilaContatoTransacional_Claim
        ON dbo.FilaContatoTransacional (Status, ProximaTentativaEm, CriadoEm, Id)
        INCLUDE (Canal, Tipo, Tentativas, MaxTentativas);
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE name = N'IX_FilaContatoTransacional_TipoCriado'
          AND object_id = OBJECT_ID(N'dbo.FilaContatoTransacional')
    )
    BEGIN
        CREATE INDEX IX_FilaContatoTransacional_TipoCriado
        ON dbo.FilaContatoTransacional (Tipo, CriadoEm DESC, Id DESC);
    END;

    SELECT
        CAST(1 AS BIT) AS Sucesso,
        N'FILA_CONTATO_TRANSACIONAL_V125 aplicado. Tabela dbo.FilaContatoTransacional criada/validada.' AS Mensagem;
END TRY
BEGIN CATCH
    DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
    RAISERROR(@ErrMsg, 16, 1);
END CATCH;
