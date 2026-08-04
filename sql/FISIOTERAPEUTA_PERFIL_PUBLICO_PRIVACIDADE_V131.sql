SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRAN;

  EXEC sys.sp_executesql N'
CREATE OR ALTER PROCEDURE dbo.SP_Fisioterapeuta_PerfilPublico
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
      AND v.CrefitoVerificado = 1;

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

  DECLARE @DefinicaoPerfilPublico NVARCHAR(MAX) =
    OBJECT_DEFINITION(OBJECT_ID(N'dbo.SP_Fisioterapeuta_PerfilPublico'));

  IF @DefinicaoPerfilPublico IS NULL
    THROW 51441, N'V131 falhou: procedure pública não encontrada após atualização.', 1;

  IF @DefinicaoPerfilPublico LIKE N'%f.CPF%'
     OR @DefinicaoPerfilPublico LIKE N'%f.CNPJ%'
     OR @DefinicaoPerfilPublico LIKE N'%DocumentoProfissional%'
     OR @DefinicaoPerfilPublico LIKE N'%f.TipoPessoa%'
    THROW 51442, N'V131 falhou: documento profissional ainda está no perfil público.', 1;

  COMMIT;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  THROW;
END CATCH;
