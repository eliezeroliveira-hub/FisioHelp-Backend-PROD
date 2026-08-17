SET NOCOUNT ON;

DECLARE
  @OrigTipo NVARCHAR(40) = CAST(SESSION_CONTEXT(N'UsuarioTipo') AS NVARCHAR(40)),
  @OrigId SQL_VARIANT = SESSION_CONTEXT(N'UsuarioId'),
  @AdminId INT;

SELECT TOP (1) @AdminId = Id
FROM dbo.Administradores
WHERE Ativo = 1
ORDER BY Id;

IF @AdminId IS NULL
  THROW 51900, N'Nenhum administrador ativo para caracterizacao V137.', 1;

EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = N'Admin';
EXEC sys.sp_set_session_context @key = N'UsuarioId', @value = @AdminId;

BEGIN TRY
  CREATE TABLE #Casos
  (
    FisioterapeutaId INT NOT NULL,
    Ano SMALLINT NOT NULL,
    Mes TINYINT NOT NULL,
    PRIMARY KEY (FisioterapeutaId, Ano, Mes)
  );

  INSERT INTO #Casos (FisioterapeutaId, Ano, Mes)
  SELECT f.Id, v.Ano, v.Mes
  FROM dbo.Fisioterapeutas f
  CROSS JOIN (VALUES
    (CONVERT(SMALLINT, 2026), CONVERT(TINYINT, 9)),
    (CONVERT(SMALLINT, 2026), CONVERT(TINYINT, 10))
  ) v(Ano, Mes)
  WHERE ISNULL(f.Ativo, 0) = 1
    AND ISNULL(f.IsBloqueado, 0) = 0
    AND ISNULL(f.CrefitoVerificado, 0) = 1
    AND ISNULL(f.EmailVerificado, 0) = 1;

  CREATE TABLE #Slots
  (
    DataHora DATETIME2(0) NOT NULL,
    Disponivel INT NOT NULL
  );

  CREATE TABLE #Resultado
  (
    FisioterapeutaId INT NOT NULL,
    Ano SMALLINT NOT NULL,
    Mes TINYINT NOT NULL,
    TotalSlots INT NOT NULL,
    SlotsDisponiveis INT NOT NULL,
    HashOrdenado VARCHAR(64) NOT NULL
  );

  DECLARE @FisioterapeutaId INT, @Ano SMALLINT, @Mes TINYINT;
  DECLARE Casos CURSOR LOCAL FAST_FORWARD FOR
    SELECT FisioterapeutaId, Ano, Mes
    FROM #Casos
    ORDER BY FisioterapeutaId, Ano, Mes;

  OPEN Casos;
  FETCH NEXT FROM Casos INTO @FisioterapeutaId, @Ano, @Mes;

  WHILE @@FETCH_STATUS = 0
  BEGIN
    TRUNCATE TABLE #Slots;

    INSERT INTO #Slots (DataHora, Disponivel)
    EXEC dbo.SP_Agenda_DisponibilidadePorMes
      @FisioterapeutaId = @FisioterapeutaId,
      @Ano = @Ano,
      @Mes = @Mes;

    DECLARE @Payload NVARCHAR(MAX);
    SELECT @Payload = STRING_AGG(
      CONVERT(NVARCHAR(MAX), CONCAT(CONVERT(VARCHAR(19), DataHora, 126), N':', Disponivel)),
      N'|'
    ) WITHIN GROUP (ORDER BY DataHora)
    FROM #Slots;

    INSERT INTO #Resultado
    (
      FisioterapeutaId,
      Ano,
      Mes,
      TotalSlots,
      SlotsDisponiveis,
      HashOrdenado
    )
    SELECT
      @FisioterapeutaId,
      @Ano,
      @Mes,
      COUNT(*),
      ISNULL(SUM(CASE WHEN Disponivel = 1 THEN 1 ELSE 0 END), 0),
      CONVERT(VARCHAR(64), HASHBYTES('SHA2_256', ISNULL(@Payload, N'')), 2)
    FROM #Slots;

    FETCH NEXT FROM Casos INTO @FisioterapeutaId, @Ano, @Mes;
  END;

  CLOSE Casos;
  DEALLOCATE Casos;

  SELECT
    FisioterapeutaId,
    Ano,
    Mes,
    TotalSlots,
    SlotsDisponiveis,
    HashOrdenado
  FROM #Resultado
  ORDER BY FisioterapeutaId, Ano, Mes;

  EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = @OrigTipo;
  EXEC sys.sp_set_session_context @key = N'UsuarioId', @value = @OrigId;
END TRY
BEGIN CATCH
  BEGIN TRY
    EXEC sys.sp_set_session_context @key = N'UsuarioTipo', @value = @OrigTipo;
    EXEC sys.sp_set_session_context @key = N'UsuarioId', @value = @OrigId;
  END TRY
  BEGIN CATCH
  END CATCH;
  THROW;
END CATCH;
