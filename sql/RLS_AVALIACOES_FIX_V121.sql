SET XACT_ABORT ON;
GO

/* =========================================================================
   RLS_AVALIACOES_FIX_V121.sql

   Corrige a RLS das tabelas de avaliacoes para permitir leitura pelo
   PacienteId alem do FisioterapeutaId.

   Problema:
     security.fn_rls_filtro_avaliacoes_fisio recebia apenas @FisioterapeutaId.
     Com isso, o paciente nao enxergava corretamente registros ligados a ele
     em dbo.Avaliacoes / dbo.AvaliacoesFisioterapeutas, afetando estados como
     card de avaliacao ja realizada.

   Estrategia:
     - Remove as duas security policies que dependem da funcao antiga.
     - Recria a funcao com dois parametros.
     - Recria as duas policies usando (FisioterapeutaId, PacienteId).

   Observacao:
     CREATE SECURITY POLICY fica em dynamic SQL para evitar binding em tempo de
     compilacao contra a assinatura antiga da funcao no mesmo batch.

   Aplicar em horario de baixo trafego: a alteracao segura locks de schema
   nas policies/tabelas enquanto a transacao estiver aberta.
   ========================================================================= */

BEGIN TRY
    BEGIN TRAN;

    IF EXISTS (
        SELECT 1
        FROM sys.security_policies pol
        JOIN sys.schemas sch
          ON sch.schema_id = pol.schema_id
        WHERE sch.name = N'security'
          AND pol.name = N'rls_policy_avaliacoes'
    )
    BEGIN
        EXEC(N'DROP SECURITY POLICY security.rls_policy_avaliacoes;');
    END;

    IF EXISTS (
        SELECT 1
        FROM sys.security_policies pol
        JOIN sys.schemas sch
          ON sch.schema_id = pol.schema_id
        WHERE sch.name = N'security'
          AND pol.name = N'rls_policy_avaliacoes_fisio'
    )
    BEGIN
        EXEC(N'DROP SECURITY POLICY security.rls_policy_avaliacoes_fisio;');
    END;

    IF OBJECT_ID(N'security.fn_rls_filtro_avaliacoes_fisio', N'IF') IS NOT NULL
    BEGIN
        EXEC(N'DROP FUNCTION security.fn_rls_filtro_avaliacoes_fisio;');
    END;

    EXEC(N'
CREATE FUNCTION security.fn_rls_filtro_avaliacoes_fisio
    (@FisioterapeutaId INT, @PacienteId INT)
RETURNS TABLE
WITH SCHEMABINDING
AS
RETURN
    SELECT 1 AS fn_result
    WHERE
        -- Logins tecnicos enxergam tudo (backend e SQL Agent)
        SUSER_SNAME() IN (N''app_backend'', N''NT SERVICE\SQLSERVERAGENT'')

        -- Admin valido (dbo.Administradores + Ativo=1)
        OR EXISTS (SELECT 1 FROM security.fn_rls_is_admin())

        -- Fisioterapeuta so ve avaliacoes ligadas a ele mesmo
        OR (
            SESSION_CONTEXT(N''UsuarioTipo'') = N''Fisioterapeuta''
            AND CONVERT(INT, SESSION_CONTEXT(N''UsuarioId'')) = @FisioterapeutaId
        )

        -- Paciente so ve avaliacoes ligadas a ele mesmo
        OR (
            SESSION_CONTEXT(N''UsuarioTipo'') = N''Paciente''
            AND CONVERT(INT, SESSION_CONTEXT(N''UsuarioId'')) = @PacienteId
        );
');

    EXEC(N'
CREATE SECURITY POLICY security.rls_policy_avaliacoes
  ADD FILTER PREDICATE security.fn_rls_filtro_avaliacoes_fisio(FisioterapeutaId, PacienteId)
  ON dbo.Avaliacoes
  WITH (STATE = ON);
');

    EXEC(N'
CREATE SECURITY POLICY security.rls_policy_avaliacoes_fisio
  ADD FILTER PREDICATE security.fn_rls_filtro_avaliacoes_fisio(FisioterapeutaId, PacienteId)
  ON dbo.AvaliacoesFisioterapeutas
  WITH (STATE = ON);
');

    COMMIT TRAN;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK TRAN;

    THROW;
END CATCH;
GO

SELECT
    1 AS Sucesso,
    N'RLS_AVALIACOES_FIX_V121 aplicado. fn_rls_filtro_avaliacoes_fisio agora tambem libera por PacienteId em dbo.Avaliacoes e dbo.AvaliacoesFisioterapeutas.' AS Mensagem;
GO
