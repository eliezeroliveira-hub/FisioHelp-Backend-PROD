/*
  FisioHelp - V133
  Reenfileira uma única vez o e-mail de aprovação do CREFITO quando o
  fisioterapeuta conclui a verificação do e-mail e já está elegível.

  A procedure participa obrigatoriamente da transação aberta pelo fluxo de
  verificação. Ela não abre transação própria.

  Execução protegida:
    EXEC sys.sp_set_session_context
      @key = N'MigrationExpectedDatabase',
      @value = N'mvpdb-hml';

  Dry-run:
    EXEC sys.sp_set_session_context
      @key = N'MigrationDryRun',
      @value = 1;
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @ExpectedDatabase SYSNAME =
  TRY_CONVERT(SYSNAME, SESSION_CONTEXT(N'MigrationExpectedDatabase'));
DECLARE @DryRun BIT =
  ISNULL(TRY_CONVERT(BIT, SESSION_CONTEXT(N'MigrationDryRun')), 0);

IF @ExpectedDatabase IS NULL OR DB_NAME() <> @ExpectedDatabase
  THROW 51460, N'V133 bloqueada: o banco atual não corresponde ao banco esperado na sessão.', 1;

IF DB_NAME() NOT IN (N'mvpdb-hml', N'FisioHelp_PROD')
  THROW 51461, N'V133 bloqueada: banco fora da lista de ambientes FisioHelp autorizados.', 1;

IF OBJECT_ID(N'dbo.Fisioterapeutas', N'U') IS NULL
   OR OBJECT_ID(N'dbo.FilaNotificacoes', N'U') IS NULL
  THROW 51462, N'V133 bloqueada: tabelas obrigatórias não foram encontradas.', 1;

BEGIN TRY
  BEGIN TRANSACTION;

  EXEC sys.sp_executesql N'
CREATE OR ALTER PROCEDURE dbo.SP_Fisio_ReenfileirarCrefitoAprovadoSeElegivel
  @FisioterapeutaId INT
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  IF @FisioterapeutaId IS NULL OR @FisioterapeutaId <= 0
    THROW 51463, N''FisioterapeutaId inválido.'', 1;

  IF @@TRANCOUNT = 0
    THROW 51464, N''A procedure deve participar de uma transação externa.'', 1;

  DECLARE
    @Nome NVARCHAR(300),
    @Ativo BIT,
    @IsBloqueado BIT,
    @CrefitoVerificado BIT,
    @EmailVerificado BIT,
    @FilaId INT = NULL,
    @AgoraLocal DATETIME2(7) =
      CONVERT(DATETIME2(7), (SYSUTCDATETIME() AT TIME ZONE ''UTC'') AT TIME ZONE ''E. South America Standard Time'');
  DECLARE @FalhasAtualizadas TABLE (Id INT NOT NULL);

  SELECT
    @Nome = Nome,
    @Ativo = ISNULL(Ativo, 0),
    @IsBloqueado = ISNULL(IsBloqueado, 0),
    @CrefitoVerificado = ISNULL(CrefitoVerificado, 0),
    @EmailVerificado = ISNULL(EmailVerificado, 0)
  FROM dbo.Fisioterapeutas WITH (UPDLOCK, HOLDLOCK)
  WHERE Id = @FisioterapeutaId;

  IF @Nome IS NULL
  BEGIN
    RETURN;
  END;

  IF @Ativo <> 1
     OR @IsBloqueado <> 0
     OR @CrefitoVerificado <> 1
     OR @EmailVerificado <> 1
  BEGIN
    RETURN;
  END;

  SELECT TOP (1) @FilaId = Id
  FROM dbo.FilaNotificacoes WITH (UPDLOCK, HOLDLOCK)
  WHERE UsuarioTipo = N''Fisioterapeuta''
    AND UsuarioId = @FisioterapeutaId
    AND Canal = N''email''
    AND JSON_VALUE(DadosJson, N''$.tipo'') = N''crefito_aprovado''
    AND Status = N''Enviado''
  ORDER BY Id DESC;

  IF @FilaId IS NOT NULL
  BEGIN
    RETURN;
  END;

  SET @FilaId = NULL;

  SELECT TOP (1) @FilaId = Id
  FROM dbo.FilaNotificacoes WITH (UPDLOCK, HOLDLOCK)
  WHERE UsuarioTipo = N''Fisioterapeuta''
    AND UsuarioId = @FisioterapeutaId
    AND Canal = N''email''
    AND JSON_VALUE(DadosJson, N''$.tipo'') = N''crefito_aprovado''
    AND Status IN (N''Pendente'', N''Processando'', N''FalhaTemporaria'')
  ORDER BY Id DESC;

  IF @FilaId IS NOT NULL
  BEGIN
    RETURN;
  END;

  SET @FilaId = NULL;

  ;WITH UltimaFalhaEmailNaoVerificado AS
  (
    SELECT TOP (1) *
    FROM dbo.FilaNotificacoes WITH (UPDLOCK, HOLDLOCK)
    WHERE UsuarioTipo = N''Fisioterapeuta''
      AND UsuarioId = @FisioterapeutaId
      AND Canal = N''email''
      AND JSON_VALUE(DadosJson, N''$.tipo'') = N''crefito_aprovado''
      AND Status = N''FalhaDefinitiva''
      AND LTRIM(RTRIM(ISNULL(UltimoErro, N''''))) = N''e-mail não verificado''
    ORDER BY Id DESC
  )
  UPDATE UltimaFalhaEmailNaoVerificado
  SET Status = N''Pendente'',
      Tentativas = 0,
      ProximaTentativaEm = @AgoraLocal,
      ProcessandoEm = NULL,
      EnviadoEm = NULL,
      UltimoErro = NULL,
      AtualizadoEm = @AgoraLocal
  OUTPUT inserted.Id INTO @FalhasAtualizadas (Id);

  SELECT TOP (1) @FilaId = Id
  FROM @FalhasAtualizadas;

  IF @FilaId IS NOT NULL
  BEGIN
    RETURN;
  END;

  INSERT INTO dbo.FilaNotificacoes
  (
    UsuarioTipo,
    UsuarioId,
    Canal,
    Tipo,
    Titulo,
    Mensagem,
    DadosJson,
    ReferenciaId,
    Status,
    Tentativas,
    ProximaTentativaEm,
    UsuarioRegistro
  )
  VALUES
  (
    N''Fisioterapeuta'',
    @FisioterapeutaId,
    N''email'',
    N''Credenciamento'',
    N''Seu CREFITO foi aprovado'',
    LEFT(CONCAT(
      N''Olá, '', LTRIM(RTRIM(@Nome)), N'','', CHAR(13), CHAR(10), CHAR(13), CHAR(10),
      N''Seu CREFITO foi verificado e aprovado com sucesso.'', CHAR(13), CHAR(10), CHAR(13), CHAR(10),
      N''Seu perfil já está ativo na FisioHelp. Agora você pode acessar a plataforma, revisar suas informações profissionais e começar a utilizar os recursos disponíveis para fisioterapeutas.'', CHAR(13), CHAR(10), CHAR(13), CHAR(10),
      N''Atenciosamente,'', CHAR(13), CHAR(10),
      N''Equipe FisioHelp''
    ), 500),
    CONCAT(N''{"tipo":"crefito_aprovado","fisioterapeutaId":'', @FisioterapeutaId, N''}''),
    @FisioterapeutaId,
    N''Pendente'',
    0,
    @AgoraLocal,
    N''Sistema:SP_Fisio_ReenfileirarCrefitoAprovadoSeElegivel''
  );

  SET @FilaId = CONVERT(INT, SCOPE_IDENTITY());
END;';

  DECLARE @Definicao NVARCHAR(MAX) =
    OBJECT_DEFINITION(OBJECT_ID(N'dbo.SP_Fisio_ReenfileirarCrefitoAprovadoSeElegivel'));

  IF @Definicao IS NULL
    THROW 51465, N'V133 falhou: procedure de reenfileiramento não foi criada.', 1;

  IF @Definicao NOT LIKE N'%WITH (UPDLOCK, HOLDLOCK)%'
     OR @Definicao NOT LIKE N'%e-mail não verificado%'
     OR @Definicao NOT LIKE N'%Status = N''Pendente''%'
     OR @Definicao LIKE N'%BEGIN TRAN%'
     OR @Definicao LIKE N'% AS Acao%'
    THROW 51466, N'V133 falhou: pós-condições da procedure não foram atendidas.', 1;

  IF @DryRun = 1
  BEGIN
    ROLLBACK;
    SELECT
      DB_NAME() AS Banco,
      CAST(1 AS BIT) AS DryRun,
      N'V133 validada; nenhuma alteração persistida.' AS Resultado;
    RETURN;
  END;

  COMMIT;

  SELECT
    DB_NAME() AS Banco,
    CAST(0 AS BIT) AS DryRun,
    N'V133 aplicada com sucesso.' AS Resultado;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  THROW;
END CATCH;
