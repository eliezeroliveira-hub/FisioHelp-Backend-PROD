/*
  FisioHelp - V132
  Garante chave Pix CPF para fisioterapeutas PF.

  Execucao protegida:
    EXEC sys.sp_set_session_context
      @key = N'MigrationExpectedDatabase',
      @value = N'mvpdb-hml';

  Dry-run:
    EXEC sys.sp_set_session_context
      @key = N'MigrationDryRun',
      @value = 1;

  A migration e transacional e pode ser executada novamente.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @ExpectedDatabase SYSNAME =
  TRY_CONVERT(SYSNAME, SESSION_CONTEXT(N'MigrationExpectedDatabase'));
DECLARE @DryRun BIT =
  ISNULL(TRY_CONVERT(BIT, SESSION_CONTEXT(N'MigrationDryRun')), 0);

IF @ExpectedDatabase IS NULL OR DB_NAME() <> @ExpectedDatabase
  THROW 51450, N'V132 bloqueada: o banco atual não corresponde ao banco esperado na sessão.', 1;

IF DB_NAME() NOT IN (N'mvpdb-hml', N'FisioHelp_PROD')
  THROW 51451, N'V132 bloqueada: banco fora da lista de ambientes FisioHelp autorizados.', 1;

IF OBJECT_ID(N'dbo.Fisioterapeutas', N'U') IS NULL
  THROW 51452, N'V132 bloqueada: dbo.Fisioterapeutas não existe.', 1;

IF COL_LENGTH(N'dbo.Fisioterapeutas', N'ChavePix') IS NULL
   OR COL_LENGTH(N'dbo.Fisioterapeutas', N'TipoChavePix') IS NULL
  THROW 51453, N'V132 bloqueada: colunas de chave Pix não foram encontradas.', 1;

BEGIN TRY
  BEGIN TRANSACTION;

  IF EXISTS (
    SELECT 1
    FROM dbo.Fisioterapeutas
    WHERE TipoChavePix IS NOT NULL
      AND TipoChavePix NOT IN (N'CPF', N'CNPJ', N'EMAIL', N'PHONE', N'EVP')
  )
    THROW 51454, N'V132 bloqueada: existem tipos de chave Pix fora do contrato conhecido.', 1;

  DECLARE @TipoPixConstraintDefinition NVARCHAR(MAX) =
    OBJECT_DEFINITION(OBJECT_ID(N'dbo.CK_Fisioterapeutas_TipoChavePix'));

  IF @TipoPixConstraintDefinition IS NULL
     OR @TipoPixConstraintDefinition NOT LIKE N'%''CPF''%'
  BEGIN
    IF OBJECT_ID(N'dbo.CK_Fisioterapeutas_TipoChavePix', N'C') IS NOT NULL
      ALTER TABLE dbo.Fisioterapeutas
        DROP CONSTRAINT CK_Fisioterapeutas_TipoChavePix;

    ALTER TABLE dbo.Fisioterapeutas WITH CHECK
      ADD CONSTRAINT CK_Fisioterapeutas_TipoChavePix
      CHECK (
        TipoChavePix IS NULL
        OR TipoChavePix IN (N'CPF', N'CNPJ', N'EMAIL', N'PHONE', N'EVP')
      );
  END;

  ALTER TABLE dbo.Fisioterapeutas WITH CHECK
    CHECK CONSTRAINT CK_Fisioterapeutas_TipoChavePix;

  IF OBJECT_ID(N'dbo.CK_Fisioterapeutas_ChavePix_Tipo', N'C') IS NULL
    THROW 51455, N'V132 falhou: constraint de pareamento entre chave e tipo Pix não existe.', 1;

  SET @TipoPixConstraintDefinition =
    OBJECT_DEFINITION(OBJECT_ID(N'dbo.CK_Fisioterapeutas_TipoChavePix'));

  IF @TipoPixConstraintDefinition IS NULL
     OR @TipoPixConstraintDefinition NOT LIKE N'%''CPF''%'
    THROW 51456, N'V132 falhou: CPF não consta na constraint de tipo de chave Pix.', 1;

  IF @DryRun = 1
  BEGIN
    ROLLBACK;
    SELECT
      DB_NAME() AS Banco,
      CAST(1 AS BIT) AS DryRun,
      N'V132 validada; nenhuma alteração persistida.' AS Resultado;
    RETURN;
  END;

  COMMIT;

  SELECT
    DB_NAME() AS Banco,
    CAST(0 AS BIT) AS DryRun,
    N'V132 aplicada com sucesso.' AS Resultado;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  THROW;
END CATCH;
