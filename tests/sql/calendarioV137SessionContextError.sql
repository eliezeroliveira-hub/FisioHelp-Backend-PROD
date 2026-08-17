SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'dbo.SP_Test_V137_ContextRestore', N'P') IS NOT NULL
  DROP PROCEDURE dbo.SP_Test_V137_ContextRestore;

EXEC sys.sp_executesql N'
CREATE PROCEDURE dbo.SP_Test_V137_ContextRestore
AS
BEGIN
  SET NOCOUNT ON;

  DECLARE
    @OrigTipo NVARCHAR(40) = CAST(SESSION_CONTEXT(N''UsuarioTipo'') AS NVARCHAR(40)),
    @OrigId SQL_VARIANT = SESSION_CONTEXT(N''UsuarioId''),
    @AdminId INT = NULL;

  BEGIN TRY
    IF ISNULL(@OrigTipo, N'''') <> N''Admin''
    BEGIN
      SELECT TOP (1) @AdminId = Id
      FROM dbo.Administradores
      WHERE Ativo = 1
      ORDER BY Id;

      IF @AdminId IS NULL
        THROW 51930, N''Nenhum administrador ativo para harness V137.'', 1;

      EXEC sys.sp_set_session_context @key = N''UsuarioTipo'', @value = N''Admin'';
      EXEC sys.sp_set_session_context @key = N''UsuarioId'', @value = @AdminId;
    END;

    IF CAST(SESSION_CONTEXT(N''UsuarioTipo'') AS NVARCHAR(40)) <> N''Admin''
      THROW 51931, N''Harness V137 nao elevou o contexto.'', 1;

    -- Erro deliberado depois da elevacao, equivalente ao ponto sensivel da V137.
    THROW 51932, N''ERRO_CONTROLADO_APOS_ELEVACAO'', 1;

    EXEC sys.sp_set_session_context @key = N''UsuarioTipo'', @value = @OrigTipo;
    EXEC sys.sp_set_session_context @key = N''UsuarioId'', @value = @OrigId;
  END TRY
  BEGIN CATCH
    BEGIN TRY
      EXEC sys.sp_set_session_context @key = N''UsuarioTipo'', @value = @OrigTipo;
      EXEC sys.sp_set_session_context @key = N''UsuarioId'', @value = @OrigId;
    END TRY
    BEGIN CATCH
    END CATCH;

    THROW;
  END CATCH;
END;';

DECLARE @AdminId INT, @PacienteId INT;

SELECT TOP (1) @AdminId = Id
FROM dbo.Administradores
WHERE Ativo = 1
ORDER BY Id;

IF @AdminId IS NULL
BEGIN
  DROP PROCEDURE dbo.SP_Test_V137_ContextRestore;
  THROW 51933, N'Nenhum administrador ativo para teste de erro V137.', 1;
END;

EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin';
EXEC sys.sp_set_session_context @key = N'UsuarioId', @value = @AdminId;

SELECT TOP (1) @PacienteId = Id
FROM dbo.Pacientes
WHERE ISNULL(IsBloqueado, 0) = 0
ORDER BY Id;

IF @PacienteId IS NULL
BEGIN
  DROP PROCEDURE dbo.SP_Test_V137_ContextRestore;
  THROW 51934, N'Nenhum paciente disponivel para teste de erro V137.', 1;
END;

EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Paciente';
EXEC sys.sp_set_session_context @key = N'UsuarioId', @value = @PacienteId;

DECLARE @ErroNumero INT = 0, @ErroMensagem NVARCHAR(4000) = NULL;

BEGIN TRY
  EXEC dbo.SP_Test_V137_ContextRestore;
END TRY
BEGIN CATCH
  SELECT
    @ErroNumero = ERROR_NUMBER(),
    @ErroMensagem = ERROR_MESSAGE();
END CATCH;

DECLARE
  @EncontradoTipo NVARCHAR(40) = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)),
  @EncontradoId INT = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));

EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = NULL;
EXEC sys.sp_set_session_context @key = N'UsuarioId', @value = NULL;

DROP PROCEDURE dbo.SP_Test_V137_ContextRestore;

IF @ErroNumero <> 51932 OR @ErroMensagem <> N'ERRO_CONTROLADO_APOS_ELEVACAO'
  THROW 51935, N'Harness V137 nao preservou o erro original.', 1;

IF @EncontradoTipo <> N'Paciente' OR @EncontradoId <> @PacienteId
  THROW 51936, N'Harness V137 nao restaurou SESSION_CONTEXT depois do erro controlado.', 1;

SELECT
  @ErroNumero AS ErroControlado,
  @ErroMensagem AS Mensagem,
  N'Paciente' AS EsperadoTipo,
  @PacienteId AS EsperadoId,
  @EncontradoTipo AS EncontradoTipo,
  @EncontradoId AS EncontradoId,
  CAST(1 AS BIT) AS Aprovado,
  CASE
    WHEN OBJECT_ID(N'dbo.SP_Test_V137_ContextRestore', N'P') IS NULL THEN N'HARNESS_REMOVIDO'
    ELSE N'HARNESS_PRESENTE'
  END AS Limpeza;
