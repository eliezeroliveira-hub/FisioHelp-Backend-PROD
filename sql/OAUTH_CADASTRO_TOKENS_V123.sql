SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRAN;

  IF OBJECT_ID(N'dbo.OAuthCadastroTokens', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.OAuthCadastroTokens (
      Jti UNIQUEIDENTIFIER NOT NULL,
      Provedor NVARCHAR(30) NOT NULL,
      Subject NVARCHAR(255) NOT NULL,
      Email NVARCHAR(300) NULL,
      EmailVerificado BIT NOT NULL CONSTRAINT DF_OAuthCadastroTokens_EmailVerificado DEFAULT (0),
      EmailRelay BIT NOT NULL CONSTRAINT DF_OAuthCadastroTokens_EmailRelay DEFAULT (0),
      Nome NVARCHAR(300) NULL,
      ExpiraEm DATETIME2(3) NOT NULL,
      UsadoEm DATETIME2(3) NULL,
      UsuarioTipo NVARCHAR(30) NULL,
      UsuarioId INT NULL,
      CriadoEm DATETIME2(3) NOT NULL CONSTRAINT DF_OAuthCadastroTokens_CriadoEm DEFAULT (SYSDATETIME()),
      AtualizadoEm DATETIME2(3) NOT NULL CONSTRAINT DF_OAuthCadastroTokens_AtualizadoEm DEFAULT (SYSDATETIME()),
      CONSTRAINT PK_OAuthCadastroTokens PRIMARY KEY CLUSTERED (Jti),
      CONSTRAINT CK_OAuthCadastroTokens_Provedor CHECK (Provedor IN (N'apple', N'google')),
      CONSTRAINT CK_OAuthCadastroTokens_Usuario CHECK (
        (UsuarioTipo IS NULL AND UsuarioId IS NULL)
        OR (UsuarioTipo IN (N'Paciente', N'Fisioterapeuta') AND UsuarioId IS NOT NULL)
      )
    );
  END;

  IF COL_LENGTH(N'dbo.OAuthCadastroTokens', N'AtualizadoEm') IS NULL
  BEGIN
    ALTER TABLE dbo.OAuthCadastroTokens
      ADD AtualizadoEm DATETIME2(3) NOT NULL
        CONSTRAINT DF_OAuthCadastroTokens_AtualizadoEm DEFAULT (SYSDATETIME()) WITH VALUES;
  END;

  IF COL_LENGTH(N'dbo.OAuthCadastroTokens', N'UsuarioTipo') IS NULL
  BEGIN
    ALTER TABLE dbo.OAuthCadastroTokens ADD UsuarioTipo NVARCHAR(30) NULL;
  END;

  IF COL_LENGTH(N'dbo.OAuthCadastroTokens', N'UsuarioId') IS NULL
  BEGIN
    ALTER TABLE dbo.OAuthCadastroTokens ADD UsuarioId INT NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = N'IX_OAuthCadastroTokens_Provedor_Subject_CriadoEm'
      AND object_id = OBJECT_ID(N'dbo.OAuthCadastroTokens')
  )
  BEGIN
    CREATE INDEX IX_OAuthCadastroTokens_Provedor_Subject_CriadoEm
      ON dbo.OAuthCadastroTokens (Provedor, Subject, CriadoEm DESC)
      INCLUDE (ExpiraEm, UsadoEm, UsuarioTipo, UsuarioId);
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = N'IX_OAuthCadastroTokens_ExpiraEm'
      AND object_id = OBJECT_ID(N'dbo.OAuthCadastroTokens')
  )
  BEGIN
    CREATE INDEX IX_OAuthCadastroTokens_ExpiraEm
      ON dbo.OAuthCadastroTokens (ExpiraEm)
      INCLUDE (UsadoEm);
  END;

  COMMIT;

  SELECT
    CAST(1 AS BIT) AS Sucesso,
    N'OAUTH_CADASTRO_TOKENS_V123 aplicado. Tabela dbo.OAuthCadastroTokens criada/validada.' AS Mensagem;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  THROW;
END CATCH;
