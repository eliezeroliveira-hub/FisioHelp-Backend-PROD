SET NOCOUNT ON;

DECLARE
  @AdminId INT,
  @PacienteId INT,
  @FisioterapeutaId INT,
  @Ano SMALLINT = 2026,
  @Mes TINYINT = 9;

SELECT TOP (1) @AdminId = Id
FROM dbo.Administradores
WHERE Ativo = 1
ORDER BY Id;

IF @AdminId IS NULL
  THROW 51910, N'Nenhum administrador ativo para teste de contexto V137.', 1;

EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin';
EXEC sys.sp_set_session_context @key = N'UsuarioId', @value = @AdminId;

SELECT TOP (1) @PacienteId = Id
FROM dbo.Pacientes
WHERE ISNULL(IsBloqueado, 0) = 0
ORDER BY Id;

SELECT TOP (1) @FisioterapeutaId = Id
FROM dbo.Fisioterapeutas
WHERE ISNULL(Ativo, 0) = 1
  AND ISNULL(IsBloqueado, 0) = 0
  AND ISNULL(CrefitoVerificado, 0) = 1
  AND ISNULL(EmailVerificado, 0) = 1
ORDER BY Id;

IF @PacienteId IS NULL OR @FisioterapeutaId IS NULL
  THROW 51911, N'Dados insuficientes para teste de contexto V137.', 1;

CREATE TABLE #Casos
(
  Ordem INT NOT NULL PRIMARY KEY,
  UsuarioTipo NVARCHAR(40) NULL,
  UsuarioId INT NULL
);

INSERT INTO #Casos (Ordem, UsuarioTipo, UsuarioId)
VALUES
  (1, NULL, NULL),
  (2, N'Paciente', @PacienteId),
  (3, N'Fisioterapeuta', @FisioterapeutaId),
  (4, N'Admin', @AdminId);

CREATE TABLE #Slots
(
  DataHora DATETIME2(0) NOT NULL,
  Disponivel INT NOT NULL
);

CREATE TABLE #Resultados
(
  Ordem INT NOT NULL,
  EsperadoTipo NVARCHAR(40) NULL,
  EsperadoId INT NULL,
  EncontradoTipo NVARCHAR(40) NULL,
  EncontradoId INT NULL,
  Aprovado BIT NOT NULL
);

DECLARE @Ordem INT, @Tipo NVARCHAR(40), @Id INT;
DECLARE Casos CURSOR LOCAL FAST_FORWARD FOR
  SELECT Ordem, UsuarioTipo, UsuarioId
  FROM #Casos
  ORDER BY Ordem;

OPEN Casos;
FETCH NEXT FROM Casos INTO @Ordem, @Tipo, @Id;

WHILE @@FETCH_STATUS = 0
BEGIN
  EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = @Tipo;
  EXEC sys.sp_set_session_context @key = N'UsuarioId', @value = @Id;

  TRUNCATE TABLE #Slots;
  INSERT INTO #Slots (DataHora, Disponivel)
  EXEC dbo.SP_Agenda_DisponibilidadePorMes
    @FisioterapeutaId = @FisioterapeutaId,
    @Ano = @Ano,
    @Mes = @Mes;

  DECLARE
    @EncontradoTipo NVARCHAR(40) = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)),
    @EncontradoId INT = TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'));

  INSERT INTO #Resultados
  (
    Ordem,
    EsperadoTipo,
    EsperadoId,
    EncontradoTipo,
    EncontradoId,
    Aprovado
  )
  VALUES
  (
    @Ordem,
    @Tipo,
    @Id,
    @EncontradoTipo,
    @EncontradoId,
    CASE
      WHEN ISNULL(@EncontradoTipo, N'#NULL#') = ISNULL(@Tipo, N'#NULL#')
       AND ISNULL(@EncontradoId, -2147483648) = ISNULL(@Id, -2147483648)
        THEN 1
      ELSE 0
    END
  );

  FETCH NEXT FROM Casos INTO @Ordem, @Tipo, @Id;
END;

CLOSE Casos;
DEALLOCATE Casos;

EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = NULL;
EXEC sys.sp_set_session_context @key = N'UsuarioId', @value = NULL;

IF EXISTS (SELECT 1 FROM #Resultados WHERE Aprovado = 0)
BEGIN
  SELECT * FROM #Resultados ORDER BY Ordem;
  THROW 51912, N'V137 falhou ao restaurar SESSION_CONTEXT no caminho de sucesso.', 1;
END;

SELECT * FROM #Resultados ORDER BY Ordem;
