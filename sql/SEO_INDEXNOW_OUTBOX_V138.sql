/*
  FisioHelp V138 - estado SEO e outbox persistente do IndexNow.

  Antes de executar:
    EXEC sys.sp_set_session_context @key=N'MigrationExpectedDatabase', @value=N'mvpdb-hml';
    -- opcional: EXEC sys.sp_set_session_context @key=N'MigrationDryRun', @value=1;
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @ExpectedDatabase SYSNAME = TRY_CONVERT(SYSNAME, SESSION_CONTEXT(N'MigrationExpectedDatabase'));
DECLARE @DryRun BIT = ISNULL(TRY_CONVERT(BIT, SESSION_CONTEXT(N'MigrationDryRun')), 0);
IF @ExpectedDatabase IS NULL OR DB_NAME() <> @ExpectedDatabase
  THROW 51880, N'V138 bloqueada: banco atual diferente do esperado.', 1;
IF DB_NAME() NOT IN (N'mvpdb-hml', N'FisioHelp_PROD')
  THROW 51881, N'V138 bloqueada: ambiente não autorizado.', 1;

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID(N'dbo.SeoPerfilEstado', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.SeoPerfilEstado (
      FisioterapeutaId INT NOT NULL CONSTRAINT PK_SeoPerfilEstado PRIMARY KEY,
      UrlCanonica NVARCHAR(600) NOT NULL,
      UrlCidade NVARCHAR(600) NOT NULL,
      Assinatura CHAR(64) NOT NULL,
      AtualizadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_SeoPerfilEstado_AtualizadoEm DEFAULT SYSDATETIME()
    );
  END;

  IF OBJECT_ID(N'dbo.IndexNowFila', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.IndexNowFila (
      Id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_IndexNowFila PRIMARY KEY,
      Url NVARCHAR(600) NOT NULL,
      Motivo NVARCHAR(60) NOT NULL,
      Status NVARCHAR(20) NOT NULL,
      Tentativas INT NOT NULL CONSTRAINT DF_IndexNowFila_Tentativas DEFAULT 0,
      ProximaTentativaEm DATETIME2(0) NOT NULL,
      UltimoErro NVARCHAR(1000) NULL,
      CriadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_IndexNowFila_CriadoEm DEFAULT SYSDATETIME(),
      AtualizadoEm DATETIME2(0) NOT NULL CONSTRAINT DF_IndexNowFila_AtualizadoEm DEFAULT SYSDATETIME(),
      CONSTRAINT CK_IndexNowFila_Status CHECK (Status IN (N'Pendente', N'Processando', N'Concluido')),
      CONSTRAINT CK_IndexNowFila_Tentativas CHECK (Tentativas >= 0)
    );
    CREATE INDEX IX_IndexNowFila_Processamento
      ON dbo.IndexNowFila (Status, ProximaTentativaEm, Id)
      INCLUDE (Url, Tentativas);
  END;

  IF @DryRun = 1 ROLLBACK;
  ELSE COMMIT;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  THROW;
END CATCH;
