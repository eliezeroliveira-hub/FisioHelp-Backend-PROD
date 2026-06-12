SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

/*
  NOTIFICACOES_TIPOS_V106
  Expande o vocabulario de tipos de notificacao para fila push e inbox in-app.

  Observacao:
  - dbo.FilaNotificacoes permite Tipo NULL.
  - dbo.Notificacoes ja tinha CHECK automatico em Tipo; recriamos com nome estavel.
*/

IF OBJECT_ID(N'dbo.FilaNotificacoes', N'U') IS NOT NULL
BEGIN
    IF EXISTS (
        SELECT 1
        FROM sys.check_constraints
        WHERE parent_object_id = OBJECT_ID(N'dbo.FilaNotificacoes')
          AND name = N'CK_FilaNotificacoes_Tipo'
    )
    BEGIN
        ALTER TABLE [dbo].[FilaNotificacoes] DROP CONSTRAINT [CK_FilaNotificacoes_Tipo];
    END;

    ALTER TABLE [dbo].[FilaNotificacoes] WITH CHECK ADD CONSTRAINT [CK_FilaNotificacoes_Tipo]
      CHECK ([Tipo] IS NULL OR [Tipo] IN
        (N'Promocao', N'Chat', N'Pagamento', N'Agendamento', N'Disputa', N'Chamado', N'Credenciamento'));

    ALTER TABLE [dbo].[FilaNotificacoes] CHECK CONSTRAINT [CK_FilaNotificacoes_Tipo];
END;
GO

IF OBJECT_ID(N'dbo.Notificacoes', N'U') IS NOT NULL
BEGIN
    DECLARE @ConstraintTipo SYSNAME;

    SELECT TOP (1) @ConstraintTipo = cc.name
    FROM sys.check_constraints cc
    WHERE cc.parent_object_id = OBJECT_ID(N'dbo.Notificacoes')
      AND cc.definition LIKE N'%Tipo%'
      AND cc.definition LIKE N'%Promocao%'
      AND cc.definition LIKE N'%Agendamento%'
    ORDER BY CASE WHEN cc.name = N'CK_Notificacoes_Tipo' THEN 0 ELSE 1 END, cc.name;

    IF @ConstraintTipo IS NOT NULL
    BEGIN
        DECLARE @dropSql NVARCHAR(MAX) =
          N'ALTER TABLE [dbo].[Notificacoes] DROP CONSTRAINT ' + QUOTENAME(@ConstraintTipo) + N';';
        EXEC sys.sp_executesql @dropSql;
    END;

    ALTER TABLE [dbo].[Notificacoes] WITH CHECK ADD CONSTRAINT [CK_Notificacoes_Tipo]
      CHECK ([Tipo] IN
        (N'Promocao', N'Chat', N'Pagamento', N'Agendamento', N'Disputa', N'Chamado', N'Credenciamento'));

    ALTER TABLE [dbo].[Notificacoes] CHECK CONSTRAINT [CK_Notificacoes_Tipo];
END;
GO

SELECT
    CAST(1 AS bit) AS Sucesso,
    N'NOTIFICACOES_TIPOS_V106 aplicado. Tipos de FilaNotificacoes e Notificacoes expandidos.' AS Mensagem;
GO
