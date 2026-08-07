/*
  FisioHelp - V134
  Exige e-mail verificado na busca e no perfil público do fisioterapeuta.

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
  THROW 51470, N'V134 bloqueada: o banco atual não corresponde ao banco esperado na sessão.', 1;

IF DB_NAME() NOT IN (N'mvpdb-hml', N'FisioHelp_PROD')
  THROW 51471, N'V134 bloqueada: banco fora da lista de ambientes FisioHelp autorizados.', 1;

IF OBJECT_ID(N'dbo.SP_Fisioterapeutas_BuscarPublico', N'P') IS NULL
   OR OBJECT_ID(N'dbo.SP_Fisioterapeuta_PerfilPublico', N'P') IS NULL
  THROW 51472, N'V134 bloqueada: procedures públicas obrigatórias não foram encontradas.', 1;

BEGIN TRY
  BEGIN TRANSACTION;

  EXEC sys.sp_executesql N'/* 5) Busca pública: filtro de data passa a exigir ao menos 1 slot real disponível */
CREATE OR ALTER PROCEDURE [dbo].[SP_Fisioterapeutas_BuscarPublico]
    @Cidade        NVARCHAR(200)  = NULL,
    @Estado        CHAR(2)        = NULL,
    @Especialidade NVARCHAR(200)  = NULL,
    @PrecoMax      DECIMAL(10, 2) = NULL,
    @DataFiltro    DATE           = NULL,
    @Lat           DECIMAL(9, 6)  = NULL,
    @Lon           DECIMAL(9, 6)  = NULL,
    @RaioKm        DECIMAL(6, 2)  = NULL,
    @Offset        INT            = 0,
    @PageSize      INT            = 50
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE
        @OrigTipo         NVARCHAR(40) = CAST(SESSION_CONTEXT(N''UsuarioTipo'') AS NVARCHAR(40)),
        @OrigId           SQL_VARIANT  = SESSION_CONTEXT(N''UsuarioId''),
        @AdminId          INT          = NULL,
        @AplicarDistancia BIT          = CASE
            WHEN @Lat IS NOT NULL AND @Lon IS NOT NULL AND @RaioKm IS NOT NULL THEN 1
            ELSE 0
        END;

    BEGIN TRY
        SET @Cidade        = NULLIF(LTRIM(RTRIM(@Cidade)),        N'''');
        SET @Estado        = NULLIF(UPPER(LTRIM(RTRIM(@Estado))), N'''');
        SET @Especialidade = NULLIF(LTRIM(RTRIM(@Especialidade)), N'''');

        IF @Offset   IS NULL OR @Offset   < 0 SET @Offset   = 0;
        IF @PageSize IS NULL OR @PageSize < 1 SET @PageSize = 50;
        IF @PageSize > 200                    SET @PageSize = 200;

        IF (ISNULL(@OrigTipo, N'''') <> N''Admin'')
        BEGIN
            SELECT TOP (1) @AdminId = Id
            FROM dbo.Administradores
            WHERE Ativo = 1
            ORDER BY Id;

            IF @AdminId IS NULL
                THROW 51041, N''Nenhum Administrador Ativo encontrado para busca pública de fisioterapeutas.'', 1;

            EXEC sys.sp_set_session_context @key = N''UsuarioTipo'', @value = N''Admin'';
            EXEC sys.sp_set_session_context @key = N''UsuarioId'',   @value = @AdminId;
        END;

        DECLARE @DuracaoMin INT = 60;
        DECLARE @Passo INT = 30;

        IF OBJECT_ID(''tempdb..#FisiosDisponiveisData'') IS NOT NULL
            DROP TABLE #FisiosDisponiveisData;

        CREATE TABLE #FisiosDisponiveisData
        (
            FisioterapeutaId INT NOT NULL PRIMARY KEY
        );

        IF @DataFiltro IS NOT NULL
        BEGIN
            DECLARE @DataInicioFiltro DATETIME2(0) = CAST(@DataFiltro AS DATETIME2(0));
            DECLARE @DataFimFiltro DATETIME2(0) = DATEADD(DAY, 1, @DataInicioFiltro);
            DECLARE @DiaSemanaFiltro TINYINT =
                (DATEPART(WEEKDAY, @DataFiltro) + @@DATEFIRST - 1) % 7; -- domingo=0

            ;WITH FisiosBase AS (
                SELECT
                    f.Id AS FisioterapeutaId,
                    ISNULL(f.IntervaloEntreConsultasMin, 30) AS BufferMin
                FROM dbo.Fisioterapeutas f
                WHERE ISNULL(f.Ativo, 0) = 1
                  AND ISNULL(f.IsBloqueado, 0) = 0
                  AND ISNULL(f.CrefitoVerificado, 0) = 1
                  AND ISNULL(f.EmailVerificado, 0) = 1 -- V134_EMAIL_FISIOS_BASE
            ),
            ExcecaoDias AS (
                SELECT
                    e.Id,
                    e.FisioterapeutaId,
                    e.Data AS DataRef,
                    e.DiaSemDisponibilidade
                FROM dbo.AgendasExcecoesDia e
                INNER JOIN FisiosBase fb
                    ON fb.FisioterapeutaId = e.FisioterapeutaId
                WHERE e.Data = @DataFiltro
            ),
            ExcecaoIntervalos AS (
                SELECT
                    e.FisioterapeutaId,
                    e.DataRef,
                    i.HoraInicio,
                    i.HoraFim,
                    fb.BufferMin
                FROM ExcecaoDias e
                INNER JOIN FisiosBase fb
                    ON fb.FisioterapeutaId = e.FisioterapeutaId
                INNER JOIN dbo.AgendasExcecoesDiaIntervalos i
                    ON i.ExcecaoDiaId = e.Id
                WHERE e.DiaSemDisponibilidade = 0
            ),
            Rotina AS (
                SELECT
                    a.FisioterapeutaId,
                    @DataFiltro AS DataRef,
                    a.HoraInicio,
                    a.HoraFim,
                    fb.BufferMin
                FROM dbo.AgendasFisioterapeutas a
                INNER JOIN FisiosBase fb
                    ON fb.FisioterapeutaId = a.FisioterapeutaId
                WHERE a.Ativo = 1
                  AND a.DiaSemana = @DiaSemanaFiltro
                  AND a.HoraFim > a.HoraInicio
                  AND NOT EXISTS (
                      SELECT 1
                      FROM ExcecaoDias ed
                      WHERE ed.FisioterapeutaId = a.FisioterapeutaId
                  )
            ),
            DisponibilidadeBase AS (
                SELECT FisioterapeutaId, DataRef, HoraInicio, HoraFim, BufferMin
                FROM ExcecaoIntervalos

                UNION ALL

                SELECT FisioterapeutaId, DataRef, HoraInicio, HoraFim, BufferMin
                FROM Rotina
            ),
            N AS (
                SELECT TOP (2000)
                    ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS n
                FROM sys.all_objects o1
                CROSS JOIN sys.all_objects o2
            ),
            SlotsBrutos AS (
                SELECT
                    b.FisioterapeutaId,
                    b.BufferMin,
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
            SlotsDisponiveis AS (
                SELECT DISTINCT
                    s.FisioterapeutaId,
                    s.BufferMin,
                    s.SlotInicio
                FROM SlotsBrutos s
                WHERE s.SlotInicio >= @DataInicioFiltro
                  AND s.SlotInicio <  @DataFimFiltro
                  AND s.SlotInicio >= SYSDATETIME()
                  AND NOT EXISTS (
                      SELECT 1
                      FROM dbo.HorariosBloqueados hb
                      WHERE hb.FisioterapeutaId = s.FisioterapeutaId
                        AND hb.DataInicio < DATEADD(MINUTE, @DuracaoMin, s.SlotInicio)
                        AND hb.DataFim    > s.SlotInicio
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM dbo.Consultas c
                      WHERE c.FisioterapeutaId = s.FisioterapeutaId
                        AND LTRIM(RTRIM(ISNULL(c.Status, N''''))) IN (N''Aguardando'', N''Confirmada'')
                        AND c.DataHora < DATEADD(MINUTE, @DuracaoMin + s.BufferMin, s.SlotInicio)
                        AND DATEADD(MINUTE, @DuracaoMin + s.BufferMin, c.DataHora) > s.SlotInicio
                  )
            )
            INSERT INTO #FisiosDisponiveisData (FisioterapeutaId)
            SELECT DISTINCT FisioterapeutaId
            FROM SlotsDisponiveis;
        END;

        -- BLOCO 1: com filtro de distância
        IF @AplicarDistancia = 1
        BEGIN
            SELECT
                f.FisioterapeutaId,
                f.Nome,
                f.CREFITO,
                COALESCE(espFiltro.EspecialidadeNome, f.Especialidade) AS Especialidade,
                f.TipoConta,
                f.Pontos,
                f.DataCadastro,
                f.LinkVideoApresentacao,
                f.ToleranciaCancelamentoMinutos,
                f.FotoPerfilDocumentoId,
                f.FotoPerfilUrl,
                COALESCE(espFiltro.ValorConsulta, f.ValorConsulta)     AS ValorConsulta,
                f.DescontoPacote,
                f.Cidade,
                f.Estado,
                f.Descricao,
                f.CrefitoVerificado,
                ISNULL(fmp.EmailVerificado,    0)                      AS EmailVerificado,
                ISNULL(fmp.TelefoneVerificado, 0)                      AS TelefoneVerificado,
                f.NotaMedia,
                f.TotalAvaliacoes,
                f.TotalAtendimentos,
                f.StatusDisponibilidade,
                COUNT(*) OVER()                                        AS TotalRegistros,
                dist.DistanciaKm,
                espFiltro.EspecialidadeId                              AS EspecialidadeFiltroId,
                espFiltro.EspecialidadeNome                            AS EspecialidadeFiltro,
                espFiltro.ValorConsultaBaseFiltro                      AS ValorConsultaBaseFiltro,
                espFiltro.ValorConsulta                                AS ValorConsultaFiltro
            FROM dbo.vw_FisioterapeutaPerfilPublico f
            LEFT JOIN dbo.FisioterapeutasMetricasPublicas fmp
                ON fmp.FisioterapeutaId = f.FisioterapeutaId
            LEFT JOIN dbo.Localizacoes l
                ON l.FisioterapeutaId = f.FisioterapeutaId
            CROSS APPLY (
                SELECT CAST(
                    l.GeoLocalizacao.STDistance(
                        geography::Point(@Lat, @Lon, 4326)
                    ) / 1000.0
                    AS DECIMAL(10, 2)
                ) AS DistanciaKm
                WHERE l.GeoLocalizacao IS NOT NULL
            ) dist
            OUTER APPLY (
                SELECT TOP (1)
                    fe.EspecialidadeId,
                    e.Nome                 AS EspecialidadeNome,
                    fe.ValorConsultaBase   AS ValorConsultaBaseFiltro,
                    vcf.ValorPacienteFinal AS ValorConsulta
                FROM       dbo.FisioterapeutaEspecialidades fe
                JOIN       dbo.Especialidades e ON e.Id = fe.EspecialidadeId
                CROSS APPLY dbo.fn_ValorConsultaFinal(fe.ValorConsultaBase) vcf
                WHERE fe.FisioterapeutaId = f.FisioterapeutaId
                  AND (@Especialidade IS NULL OR e.Nome LIKE N''%'' + @Especialidade + N''%'')
                ORDER BY fe.Principal DESC, e.Nome ASC
            ) espFiltro
            WHERE f.CrefitoVerificado = 1
              AND ISNULL(fmp.EmailVerificado, 0) = 1 -- V134_EMAIL_RESULTADO
              AND f.Ativo        = 1
              AND f.IsBloqueado  = 0
              AND (@Cidade IS NULL OR f.Cidade LIKE N''%'' + @Cidade + N''%'')
              AND (@Estado IS NULL OR f.Estado = @Estado)
              AND (@Especialidade IS NULL OR espFiltro.EspecialidadeId IS NOT NULL)
              AND (
                  @PrecoMax IS NULL
                  OR COALESCE(espFiltro.ValorConsulta, f.ValorConsulta) <= @PrecoMax
              )
              AND (
                  @DataFiltro IS NULL
                  OR EXISTS (
                      SELECT 1
                      FROM #FisiosDisponiveisData fd
                      WHERE fd.FisioterapeutaId = f.FisioterapeutaId
                  )
              )
              AND dist.DistanciaKm IS NOT NULL
              AND dist.DistanciaKm <= @RaioKm
              AND dist.DistanciaKm <= l.RaioAtendimentoKm
            ORDER BY
                dist.DistanciaKm ASC,
                CASE WHEN UPPER(LTRIM(RTRIM(ISNULL(f.TipoConta, N'''')))) = N''PREMIUM'' THEN 0 ELSE 1 END ASC,
                CASE WHEN ISNULL(f.CrefitoVerificado, 0)    = 1
                          AND ISNULL(fmp.EmailVerificado, 0)    = 1
                          AND ISNULL(fmp.TelefoneVerificado, 0) = 1 THEN 0 ELSE 1 END ASC,
                CASE WHEN ISNULL(LTRIM(RTRIM(f.StatusDisponibilidade)), N'''') = N''Disponível'' THEN 0 ELSE 1 END ASC,
                ISNULL(f.NotaMedia,        0) DESC,
                ISNULL(f.TotalAtendimentos,0) DESC,
                ISNULL(f.TotalAvaliacoes,  0) DESC,
                f.FisioterapeutaId ASC
            OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY;
        END

        -- BLOCO 2: sem filtro de distância
        ELSE
        BEGIN
            SELECT
                f.FisioterapeutaId,
                f.Nome,
                f.CREFITO,
                COALESCE(espFiltro.EspecialidadeNome, f.Especialidade) AS Especialidade,
                f.TipoConta,
                f.Pontos,
                f.DataCadastro,
                f.LinkVideoApresentacao,
                f.ToleranciaCancelamentoMinutos,
                f.FotoPerfilDocumentoId,
                f.FotoPerfilUrl,
                COALESCE(espFiltro.ValorConsulta, f.ValorConsulta)     AS ValorConsulta,
                f.DescontoPacote,
                f.Cidade,
                f.Estado,
                f.Descricao,
                f.CrefitoVerificado,
                ISNULL(fmp.EmailVerificado,    0)                      AS EmailVerificado,
                ISNULL(fmp.TelefoneVerificado, 0)                      AS TelefoneVerificado,
                f.NotaMedia,
                f.TotalAvaliacoes,
                f.TotalAtendimentos,
                f.StatusDisponibilidade,
                COUNT(*) OVER()                                        AS TotalRegistros,
                CAST(NULL AS DECIMAL(10, 2))                           AS DistanciaKm,
                espFiltro.EspecialidadeId                              AS EspecialidadeFiltroId,
                espFiltro.EspecialidadeNome                            AS EspecialidadeFiltro,
                espFiltro.ValorConsultaBaseFiltro                      AS ValorConsultaBaseFiltro,
                espFiltro.ValorConsulta                                AS ValorConsultaFiltro
            FROM dbo.vw_FisioterapeutaPerfilPublico f
            LEFT JOIN dbo.FisioterapeutasMetricasPublicas fmp
                ON fmp.FisioterapeutaId = f.FisioterapeutaId
            OUTER APPLY (
                SELECT TOP (1)
                    fe.EspecialidadeId,
                    e.Nome                 AS EspecialidadeNome,
                    fe.ValorConsultaBase   AS ValorConsultaBaseFiltro,
                    vcf.ValorPacienteFinal AS ValorConsulta
                FROM       dbo.FisioterapeutaEspecialidades fe
                JOIN       dbo.Especialidades e ON e.Id = fe.EspecialidadeId
                CROSS APPLY dbo.fn_ValorConsultaFinal(fe.ValorConsultaBase) vcf
                WHERE fe.FisioterapeutaId = f.FisioterapeutaId
                  AND (@Especialidade IS NULL OR e.Nome LIKE N''%'' + @Especialidade + N''%'')
                ORDER BY fe.Principal DESC, e.Nome ASC
            ) espFiltro
            WHERE f.CrefitoVerificado = 1
              AND ISNULL(fmp.EmailVerificado, 0) = 1 -- V134_EMAIL_RESULTADO
              AND f.Ativo        = 1
              AND f.IsBloqueado  = 0
              AND (@Cidade IS NULL OR f.Cidade LIKE N''%'' + @Cidade + N''%'')
              AND (@Estado IS NULL OR f.Estado = @Estado)
              AND (@Especialidade IS NULL OR espFiltro.EspecialidadeId IS NOT NULL)
              AND (
                  @PrecoMax IS NULL
                  OR COALESCE(espFiltro.ValorConsulta, f.ValorConsulta) <= @PrecoMax
              )
              AND (
                  @DataFiltro IS NULL
                  OR EXISTS (
                      SELECT 1
                      FROM #FisiosDisponiveisData fd
                      WHERE fd.FisioterapeutaId = f.FisioterapeutaId
                  )
              )
            ORDER BY
                CASE WHEN ISNULL(LTRIM(RTRIM(f.StatusDisponibilidade)), N'''') = N''Disponível'' THEN 0 ELSE 1 END ASC,
                CASE WHEN UPPER(LTRIM(RTRIM(ISNULL(f.TipoConta, N'''')))) = N''PREMIUM'' THEN 0 ELSE 1 END ASC,
                CASE WHEN ISNULL(f.CrefitoVerificado, 0)    = 1
                          AND ISNULL(fmp.EmailVerificado, 0)    = 1
                          AND ISNULL(fmp.TelefoneVerificado, 0) = 1 THEN 0 ELSE 1 END ASC,
                ISNULL(f.NotaMedia,        0) DESC,
                ISNULL(f.TotalAtendimentos,0) DESC,
                ISNULL(f.TotalAvaliacoes,  0) DESC,
                f.FisioterapeutaId ASC
            OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY;
        END

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

  EXEC sys.sp_executesql N'CREATE OR ALTER PROCEDURE dbo.SP_Fisioterapeuta_PerfilPublico
  @FisioterapeutaId INT
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  DECLARE
    @OrigTipo NVARCHAR(40) = CAST(SESSION_CONTEXT(N''UsuarioTipo'') AS NVARCHAR(40)),
    @OrigId SQL_VARIANT = SESSION_CONTEXT(N''UsuarioId''),
    @AdminId INT = NULL;

  BEGIN TRY
    IF @FisioterapeutaId IS NULL OR @FisioterapeutaId <= 0
      THROW 51031, N''FisioterapeutaId inválido.'', 1;

    IF ISNULL(@OrigTipo, N'''') <> N''Admin''
    BEGIN
      SELECT TOP (1) @AdminId = Id
      FROM dbo.Administradores
      WHERE Ativo = 1
      ORDER BY Id;

      IF @AdminId IS NULL
        THROW 51032, N''Nenhum Administrador Ativo encontrado para leitura pública do perfil.'', 1;

      EXEC sys.sp_set_session_context @key = N''UsuarioTipo'', @value = N''Admin'';
      EXEC sys.sp_set_session_context @key = N''UsuarioId'', @value = @AdminId;
    END;

    SELECT
      v.FisioterapeutaId,
      v.Nome,
      v.CREFITO,
      v.Especialidade,
      v.TipoConta,
      v.Pontos,
      v.DataCadastro,
      v.LinkVideoApresentacao,
      v.ToleranciaCancelamentoMinutos,
      v.FotoPerfilDocumentoId,
      v.FotoPerfilUrl,
      v.ValorConsulta,
      v.DescontoPacote,
      v.Cidade,
      v.Estado,
      v.Descricao,
      v.CrefitoVerificado,
      ISNULL(fmp.EmailVerificado, 0) AS EmailVerificado,
      ISNULL(fmp.TelefoneVerificado, 0) AS TelefoneVerificado,
      v.NotaMedia,
      v.TotalAvaliacoes,
      v.TotalAtendimentos,
      v.StatusDisponibilidade
    FROM dbo.vw_FisioterapeutaPerfilPublico v
    LEFT JOIN dbo.FisioterapeutasMetricasPublicas fmp
      ON fmp.FisioterapeutaId = v.FisioterapeutaId
    WHERE v.FisioterapeutaId = @FisioterapeutaId
      AND v.Ativo = 1
      AND v.IsBloqueado = 0
      AND v.CrefitoVerificado = 1
      AND ISNULL(fmp.EmailVerificado, 0) = 1; -- V134_EMAIL_PERFIL

    SELECT
      a.Id AS AvaliacaoId,
      p.Nome AS NomePaciente,
      a.Nota,
      a.Comentario,
      a.DataAvaliacao
    FROM dbo.AvaliacoesFisioterapeutas a
    LEFT JOIN dbo.Pacientes p ON p.Id = a.PacienteId
    WHERE a.FisioterapeutaId = @FisioterapeutaId
    ORDER BY a.DataAvaliacao DESC, a.Id DESC;

    SELECT
      Id, Curso, Instituicao, MesInicio, AnoInicio, MesFim, AnoFim,
      Descricao, IdCredencial, UrlCredencial
    FROM dbo.vw_FormacoesFisioterapeutas
    WHERE FisioterapeutaId = @FisioterapeutaId
    ORDER BY
      CASE WHEN AnoInicio IS NULL THEN 1 ELSE 0 END,
      AnoInicio DESC,
      CASE WHEN MesInicio IS NULL THEN 1 ELSE 0 END,
      MesInicio DESC,
      Id DESC;

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
  END CATCH
END;';

  DECLARE @DefinicaoBusca NVARCHAR(MAX) =
    OBJECT_DEFINITION(OBJECT_ID(N'dbo.SP_Fisioterapeutas_BuscarPublico'));
  DECLARE @DefinicaoPerfil NVARCHAR(MAX) =
    OBJECT_DEFINITION(OBJECT_ID(N'dbo.SP_Fisioterapeuta_PerfilPublico'));

  IF @DefinicaoBusca IS NULL
     OR @DefinicaoBusca NOT LIKE N'%V134_EMAIL_FISIOS_BASE%'
     OR (
       (LEN(@DefinicaoBusca) - LEN(REPLACE(@DefinicaoBusca, N'V134_EMAIL_RESULTADO', N'')))
       / LEN(N'V134_EMAIL_RESULTADO')
     ) <> 2
    THROW 51473, N'V134 falhou: busca pública não contém todos os filtros de e-mail.', 1;

  IF @DefinicaoPerfil IS NULL
     OR @DefinicaoPerfil NOT LIKE N'%V134_EMAIL_PERFIL%'
     OR @DefinicaoPerfil NOT LIKE N'%v.Ativo = 1%'
     OR @DefinicaoPerfil NOT LIKE N'%v.IsBloqueado = 0%'
    THROW 51474, N'V134 falhou: perfil público não contém a elegibilidade completa.', 1;

  IF @DryRun = 1
  BEGIN
    ROLLBACK;
    SELECT
      DB_NAME() AS Banco,
      CAST(1 AS BIT) AS DryRun,
      N'V134 validada; nenhuma alteração persistida.' AS Resultado;
    RETURN;
  END;

  COMMIT;

  SELECT
    DB_NAME() AS Banco,
    CAST(0 AS BIT) AS DryRun,
    N'V134 aplicada com sucesso.' AS Resultado;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  THROW;
END CATCH;
