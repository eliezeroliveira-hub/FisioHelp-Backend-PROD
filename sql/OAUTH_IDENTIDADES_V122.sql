SET XACT_ABORT ON;
GO

/* =========================================================================
   OAUTH_IDENTIDADES_V122.sql

   Cria uma tabela de vinculo entre contas internas e identidades OAuth
   externas (Google/Apple). Isso permite que Sign in with Apple continue
   funcionando quando o usuario escolhe "Ocultar Meu E-mail" e a Apple passa
   a retornar um e-mail relay diferente do e-mail cadastrado.

   Estrategia:
     - Chave unica por (Provedor, Subject).
     - O login OAuth primeiro busca por Provedor+Subject.
     - Quando o login por e-mail funciona, o backend grava esse vinculo para
       os proximos logins.
   ========================================================================= */

BEGIN TRY
    BEGIN TRAN;

    IF OBJECT_ID(N'dbo.UsuarioOAuthIdentidades', N'U') IS NULL
    BEGIN
        CREATE TABLE dbo.UsuarioOAuthIdentidades
        (
            Id BIGINT IDENTITY(1,1) NOT NULL
                CONSTRAINT PK_UsuarioOAuthIdentidades PRIMARY KEY,
            Provedor NVARCHAR(30) NOT NULL,
            Subject NVARCHAR(255) NOT NULL,
            UsuarioTipo NVARCHAR(30) NOT NULL,
            UsuarioId INT NOT NULL,
            EmailAtual NVARCHAR(300) NULL,
            EmailRelay BIT NOT NULL
                CONSTRAINT DF_UsuarioOAuthIdentidades_EmailRelay DEFAULT (0),
            NomeAtual NVARCHAR(300) NULL,
            CriadoEm DATETIME2(3) NOT NULL
                CONSTRAINT DF_UsuarioOAuthIdentidades_CriadoEm DEFAULT (SYSDATETIME()),
            AtualizadoEm DATETIME2(3) NOT NULL
                CONSTRAINT DF_UsuarioOAuthIdentidades_AtualizadoEm DEFAULT (SYSDATETIME()),
            UltimoLoginEm DATETIME2(3) NULL,
            RevogadoEm DATETIME2(3) NULL
        );
    END;

    IF COL_LENGTH(N'dbo.UsuarioOAuthIdentidades', N'RevogadoEm') IS NULL
    BEGIN
        ALTER TABLE dbo.UsuarioOAuthIdentidades
            ADD RevogadoEm DATETIME2(3) NULL;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.UsuarioOAuthIdentidades')
          AND name = N'UX_UsuarioOAuthIdentidades_Provedor_Subject_Ativo'
    )
    BEGIN
        CREATE UNIQUE INDEX UX_UsuarioOAuthIdentidades_Provedor_Subject_Ativo
            ON dbo.UsuarioOAuthIdentidades (Provedor, Subject)
            WHERE RevogadoEm IS NULL;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.UsuarioOAuthIdentidades')
          AND name = N'IX_UsuarioOAuthIdentidades_Usuario'
    )
    BEGIN
        CREATE INDEX IX_UsuarioOAuthIdentidades_Usuario
            ON dbo.UsuarioOAuthIdentidades (UsuarioTipo, UsuarioId);
    END;

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
    N'OAUTH_IDENTIDADES_V122 aplicado. Tabela dbo.UsuarioOAuthIdentidades criada/validada.' AS Mensagem;
GO
