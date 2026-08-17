/*
  FisioHelp - rollback da V137
  Restaura a logica anterior de dbo.SP_Agenda_DisponibilidadePorMes.

  Origem capturada em PROD antes da V137:
    SHA-256: BA8405362E31D77BE53D8E73324A9917EADA63A01B44DE462C1EEAB51018F025
    tamanho: 5444 caracteres

  Execucao protegida:
    EXEC sys.sp_set_session_context
      @key = N'MigrationExpectedDatabase',
      @value = N'FisioHelp_PROD';

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
  THROW 51710, N'Rollback V137 bloqueado: banco atual diferente do esperado.', 1;

IF DB_NAME() NOT IN (N'mvpdb-hml', N'FisioHelp_PROD')
  THROW 51711, N'Rollback V137 bloqueado: banco fora dos ambientes autorizados.', 1;

DECLARE @DefinicaoAtual NVARCHAR(MAX) =
  OBJECT_DEFINITION(OBJECT_ID(N'dbo.SP_Agenda_DisponibilidadePorMes'));

IF @DefinicaoAtual IS NULL
   OR @DefinicaoAtual NOT LIKE N'%V137_TALLY_48%'
   OR @DefinicaoAtual NOT LIKE N'%V137_NATIVE_DATETIME%'
   OR @DefinicaoAtual NOT LIKE N'%V137_RLS_RESTORE_SUCCESS%'
   OR @DefinicaoAtual NOT LIKE N'%V137_RLS_RESTORE_CATCH%'
  THROW 51712, N'Rollback V137 bloqueado: a procedure atual nao corresponde a V137.', 1;

BEGIN TRY
  BEGIN TRANSACTION;

  EXEC sys.sp_executesql N'
/* 3) Calendario mensal publico do perfil do fisioterapeuta - pre-V137 */
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
      SELECT TOP (2000)
        ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS n
      FROM sys.all_objects o1
      CROSS JOIN sys.all_objects o2
    ),
    SlotsBrutos AS (
      SELECT
        CAST(
          DATEADD(
            MINUTE,
            n.n * @Passo,
            CAST(CONVERT(varchar(10), b.DataRef, 23) + ''T'' + CONVERT(varchar(8), b.HoraInicio, 108) AS datetime2(0))
          ) AS datetime2(0)
        ) AS SlotInicio
      FROM DisponibilidadeBase b
      INNER JOIN N n
        ON DATEADD(
             MINUTE,
             n.n * @Passo,
             CAST(CONVERT(varchar(10), b.DataRef, 23) + ''T'' + CONVERT(varchar(8), b.HoraInicio, 108) AS datetime2(0))
           ) <= DATEADD(
                  MINUTE,
                  -@DuracaoMin,
                  CAST(CONVERT(varchar(10), b.DataRef, 23) + ''T'' + CONVERT(varchar(8), b.HoraFim, 108) AS datetime2(0))
                )
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

    EXEC sys.sp_set_session_context @key = N''UsuarioTipo'', @value = @OrigTipo;
    EXEC sys.sp_set_session_context @key = N''UsuarioId'',   @value = @OrigId;
  END TRY
  BEGIN CATCH
    BEGIN TRY
      EXEC sys.sp_set_session_context @key = N''UsuarioTipo'', @value = @OrigTipo;
      EXEC sys.sp_set_session_context @key = N''UsuarioId'',   @value = @OrigId;
    END TRY
    BEGIN CATCH
    END CATCH;

    THROW;
  END CATCH
END;';

  DECLARE @DefinicaoRestaurada NVARCHAR(MAX) =
    OBJECT_DEFINITION(OBJECT_ID(N'dbo.SP_Agenda_DisponibilidadePorMes'));

  IF @DefinicaoRestaurada IS NULL
     OR @DefinicaoRestaurada NOT LIKE N'%FROM sys.all_objects o1%'
     OR @DefinicaoRestaurada NOT LIKE N'%CROSS JOIN sys.all_objects o2%'
     OR @DefinicaoRestaurada LIKE N'%V137_TALLY_48%'
     OR @DefinicaoRestaurada NOT LIKE N'%OPTION (MAXRECURSION 370)%'
    THROW 51713, N'Rollback V137 falhou no postflight estrutural.', 1;

  IF @DryRun = 1
  BEGIN
    ROLLBACK;
    SELECT DB_NAME() AS Banco, CAST(1 AS BIT) AS DryRun,
      N'Rollback V137 validado; nenhuma alteracao persistida.' AS Resultado;
    RETURN;
  END;

  COMMIT;
  SELECT DB_NAME() AS Banco, CAST(0 AS BIT) AS DryRun,
    N'Rollback V137 aplicado.' AS Resultado;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  THROW;
END CATCH;
