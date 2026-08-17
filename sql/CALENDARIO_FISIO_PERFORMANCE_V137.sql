/*
  FisioHelp - V137
  Estabiliza o plano do calendario mensal publico do fisioterapeuta.

  Alteracoes deliberadamente restritas:
    - substitui o gerador baseado em sys.all_objects por 48 valores constantes;
    - calcula os limites datetime2 uma unica vez por intervalo, sem concatenar texto;
    - preserva contrato, regras de disponibilidade e bypass/restauracao de RLS.

  Execucao protegida:
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
  THROW 51700, N'V137 bloqueada: o banco atual nao corresponde ao banco esperado na sessao.', 1;

IF DB_NAME() NOT IN (N'mvpdb-hml', N'FisioHelp_PROD')
  THROW 51701, N'V137 bloqueada: banco fora da lista de ambientes FisioHelp autorizados.', 1;

IF OBJECT_ID(N'dbo.SP_Agenda_DisponibilidadePorMes', N'P') IS NULL
  THROW 51702, N'V137 bloqueada: SP_Agenda_DisponibilidadePorMes nao encontrada.', 1;

DECLARE @DefinicaoAnterior NVARCHAR(MAX) =
  OBJECT_DEFINITION(OBJECT_ID(N'dbo.SP_Agenda_DisponibilidadePorMes'));

IF @DefinicaoAnterior IS NULL
   OR @DefinicaoAnterior NOT LIKE N'%FROM sys.all_objects o1%'
   OR @DefinicaoAnterior NOT LIKE N'%CROSS JOIN sys.all_objects o2%'
   OR @DefinicaoAnterior NOT LIKE N'%DECLARE @Passo INT = 30%'
   OR @DefinicaoAnterior NOT LIKE N'%SESSION_CONTEXT(N''UsuarioTipo'')%'
   OR @DefinicaoAnterior NOT LIKE N'%OPTION (MAXRECURSION 370)%'
  THROW 51703, N'V137 bloqueada: a definicao atual da procedure diverge da base esperada.', 1;

BEGIN TRY
  BEGIN TRANSACTION;

  EXEC sys.sp_executesql N'
/* 3) Calendario mensal publico do perfil do fisioterapeuta - V137 */
CREATE OR ALTER PROCEDURE [dbo].[SP_Agenda_DisponibilidadePorMes]
  @FisioterapeutaId INT,
  @Ano SMALLINT,
  @Mes TINYINT,
  @DuracaoMin TINYINT = 60
AS
BEGIN
  SET NOCOUNT ON;
  SET DATEFIRST 7; -- domingo = 1 (compativel com DiaSemana 0..6)

  IF @FisioterapeutaId IS NULL OR @FisioterapeutaId <= 0
    THROW 50001, N''FisioterapeutaId invalido.'', 1;

  IF @Ano < 2020 OR @Ano > 2100
    THROW 50002, N''Ano invalido.'', 1;

  IF @Mes < 1 OR @Mes > 12
    THROW 50003, N''Mes invalido.'', 1;

  IF @DuracaoMin IS NULL OR @DuracaoMin <= 0 OR @DuracaoMin > 240
    THROW 50004, N''DuracaoMin invalida.'', 1;

  DECLARE @BufferMin INT = 30;

  SELECT @BufferMin = ISNULL(IntervaloEntreConsultasMin, 30)
  FROM dbo.Fisioterapeutas
  WHERE Id = @FisioterapeutaId;

  DECLARE @Passo INT = 30;

  DECLARE
    @OrigTipo NVARCHAR(40) = CAST(SESSION_CONTEXT(N''UsuarioTipo'') AS NVARCHAR(40)),
    @OrigId   SQL_VARIANT  = SESSION_CONTEXT(N''UsuarioId''),
    @AdminId  INT = NULL;

  BEGIN TRY
    IF (ISNULL(@OrigTipo, N'''') <> N''Admin'')
    BEGIN
      SELECT TOP (1) @AdminId = Id
      FROM dbo.Administradores
      WHERE Ativo = 1
      ORDER BY Id;

      IF @AdminId IS NULL
        THROW 51011, N''Nenhum Administrador Ativo encontrado para bypass de RLS na disponibilidade.'', 1;

      EXEC sys.sp_set_session_context @key = N''UsuarioTipo'', @value = N''Admin'';
      EXEC sys.sp_set_session_context @key = N''UsuarioId'',   @value = @AdminId;
    END;

    DECLARE @DataInicio DATE = DATEFROMPARTS(@Ano, @Mes, 1);
    DECLARE @DataFimExclusiva DATE = DATEADD(MONTH, 1, @DataInicio);

    ;WITH Dias AS (
      SELECT @DataInicio AS DataRef
      UNION ALL
      SELECT DATEADD(DAY, 1, DataRef)
      FROM Dias
      WHERE DataRef < DATEADD(DAY, -1, @DataFimExclusiva)
    ),
    ExcecaoDias AS (
      SELECT
        e.Id,
        e.Data AS DataRef,
        e.DiaSemDisponibilidade
      FROM dbo.AgendasExcecoesDia e
      WHERE e.FisioterapeutaId = @FisioterapeutaId
        AND e.Data >= @DataInicio
        AND e.Data <  @DataFimExclusiva
    ),
    ExcecaoIntervalos AS (
      SELECT
        e.DataRef,
        i.HoraInicio,
        i.HoraFim
      FROM ExcecaoDias e
      INNER JOIN dbo.AgendasExcecoesDiaIntervalos i
        ON i.ExcecaoDiaId = e.Id
      WHERE e.DiaSemDisponibilidade = 0
    ),
    Rotina AS (
      SELECT
        d.DataRef,
        a.HoraInicio,
        a.HoraFim
      FROM Dias d
      INNER JOIN dbo.AgendasFisioterapeutas a
        ON a.FisioterapeutaId = @FisioterapeutaId
       AND a.Ativo = 1
       AND a.DiaSemana = (DATEPART(WEEKDAY, d.DataRef) - 1)
      WHERE NOT EXISTS (
        SELECT 1
        FROM ExcecaoDias ed
        WHERE ed.DataRef = d.DataRef
      )
    ),
    DisponibilidadeBase AS (
      SELECT
        ei.DataRef,
        ei.HoraInicio,
        ei.HoraFim
      FROM ExcecaoIntervalos ei

      UNION ALL

      SELECT
        r.DataRef,
        r.HoraInicio,
        r.HoraFim
      FROM Rotina r
    ),
    N AS (
      -- V137_TALLY_48: @Passo e fixo em 30 min; um dia possui no maximo 48 slots.
      SELECT n
      FROM (VALUES
        (0),(1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),
        (12),(13),(14),(15),(16),(17),(18),(19),(20),(21),(22),(23),
        (24),(25),(26),(27),(28),(29),(30),(31),(32),(33),(34),(35),
        (36),(37),(38),(39),(40),(41),(42),(43),(44),(45),(46),(47)
      ) AS Numeros(n)
    ),
    BasesCalculadas AS (
      -- V137_NATIVE_DATETIME: evita varchar e calcula cada limite uma vez por intervalo.
      SELECT
        InicioBase = DATEADD(
          SECOND,
          DATEDIFF(SECOND, CAST(''00:00:00'' AS time), b.HoraInicio),
          CAST(b.DataRef AS datetime2(0))
        ),
        FimBase = DATEADD(
          SECOND,
          DATEDIFF(SECOND, CAST(''00:00:00'' AS time), b.HoraFim),
          CAST(b.DataRef AS datetime2(0))
        )
      FROM DisponibilidadeBase b
    ),
    SlotsBrutos AS (
      SELECT
        CAST(DATEADD(MINUTE, n.n * @Passo, b.InicioBase) AS datetime2(0)) AS SlotInicio
      FROM BasesCalculadas b
      INNER JOIN N n
        ON n.n * @Passo <= DATEDIFF(MINUTE, b.InicioBase, b.FimBase) - @DuracaoMin
    ),
    Slots AS (
      SELECT DISTINCT SlotInicio
      FROM SlotsBrutos
      WHERE SlotInicio >= CAST(@DataInicio AS datetime2(0))
        AND SlotInicio <  CAST(@DataFimExclusiva AS datetime2(0))
    )
    SELECT
      s.SlotInicio AS DataHora,
      CASE
        WHEN s.SlotInicio < SYSDATETIME() THEN 0
        WHEN EXISTS (
          SELECT 1
          FROM dbo.HorariosBloqueados hb
          WHERE hb.FisioterapeutaId = @FisioterapeutaId
            AND hb.DataInicio < DATEADD(MINUTE, @DuracaoMin, s.SlotInicio)
            AND hb.DataFim    > s.SlotInicio
        ) THEN 0
        WHEN EXISTS (
          SELECT 1
          FROM dbo.Consultas c
          WHERE c.FisioterapeutaId = @FisioterapeutaId
            AND LTRIM(RTRIM(ISNULL(c.Status, N''''))) IN (N''Aguardando'', N''Confirmada'')
            AND c.DataHora < DATEADD(MINUTE, @DuracaoMin + @BufferMin, s.SlotInicio)
            AND DATEADD(MINUTE, @DuracaoMin + @BufferMin, c.DataHora) > s.SlotInicio
        ) THEN 0
        ELSE 1
      END AS Disponivel
    FROM Slots s
    ORDER BY s.SlotInicio
    OPTION (MAXRECURSION 370);

    -- V137_RLS_RESTORE_SUCCESS: conexoes sao reutilizadas pelo pool da API.
    EXEC sys.sp_set_session_context @key = N''UsuarioTipo'', @value = @OrigTipo;
    EXEC sys.sp_set_session_context @key = N''UsuarioId'',   @value = @OrigId;
  END TRY
  BEGIN CATCH
    BEGIN TRY
      -- V137_RLS_RESTORE_CATCH: nunca deixar o contexto Admin na conexao fisica.
      EXEC sys.sp_set_session_context @key = N''UsuarioTipo'', @value = @OrigTipo;
      EXEC sys.sp_set_session_context @key = N''UsuarioId'',   @value = @OrigId;
    END TRY
    BEGIN CATCH
    END CATCH;

    THROW;
  END CATCH
END;';

  DECLARE @DefinicaoNova NVARCHAR(MAX) =
    OBJECT_DEFINITION(OBJECT_ID(N'dbo.SP_Agenda_DisponibilidadePorMes'));

  IF @DefinicaoNova IS NULL
     OR @DefinicaoNova LIKE N'%sys.all_objects%'
     OR @DefinicaoNova NOT LIKE N'%V137_TALLY_48%'
     OR @DefinicaoNova NOT LIKE N'%V137_NATIVE_DATETIME%'
     OR @DefinicaoNova NOT LIKE N'%V137_RLS_RESTORE_SUCCESS%'
     OR @DefinicaoNova NOT LIKE N'%V137_RLS_RESTORE_CATCH%'
     OR @DefinicaoNova NOT LIKE N'%OPTION (MAXRECURSION 370)%'
    THROW 51704, N'V137 falhou: a procedure otimizada nao passou no postflight estrutural.', 1;

  IF @DryRun = 1
  BEGIN
    ROLLBACK;
    SELECT
      DB_NAME() AS Banco,
      CAST(1 AS BIT) AS DryRun,
      N'V137 validada; nenhuma alteracao persistida.' AS Resultado;
    RETURN;
  END;

  COMMIT;

  SELECT
    DB_NAME() AS Banco,
    CAST(0 AS BIT) AS DryRun,
    N'V137 aplicada com sucesso.' AS Resultado;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  THROW;
END CATCH;
