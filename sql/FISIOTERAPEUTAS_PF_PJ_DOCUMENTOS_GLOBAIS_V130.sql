/*
  FisioHelp - V130
  Habilita fisioterapeutas PF/PJ com identidade documental global.

  Execucao protegida:
    EXEC sys.sp_set_session_context
      @key = N'MigrationExpectedDatabase',
      @value = N'mvpdb-hml';

  Dry-run:
    EXEC sys.sp_set_session_context
      @key = N'MigrationDryRun',
      @value = 1;

  A migration e transacional e pode ser executada novamente.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @ExpectedDatabase SYSNAME =
  TRY_CONVERT(SYSNAME, SESSION_CONTEXT(N'MigrationExpectedDatabase'));
DECLARE @DryRun BIT =
  ISNULL(TRY_CONVERT(BIT, SESSION_CONTEXT(N'MigrationDryRun')), 0);

IF @ExpectedDatabase IS NULL OR DB_NAME() <> @ExpectedDatabase
  THROW 51430, N'V130 bloqueada: o banco atual não corresponde ao banco esperado na sessão.', 1;

IF DB_NAME() NOT IN (N'mvpdb-hml', N'FisioHelp_PROD')
  THROW 51431, N'V130 bloqueada: banco fora da lista de ambientes FisioHelp autorizados.', 1;

IF OBJECT_ID(N'dbo.Fisioterapeutas', N'U') IS NULL
  THROW 51432, N'V130 bloqueada: dbo.Fisioterapeutas não existe.', 1;

IF OBJECT_ID(N'dbo.Pacientes', N'U') IS NULL
  THROW 51433, N'V130 bloqueada: dbo.Pacientes não existe.', 1;

BEGIN TRY
  BEGIN TRANSACTION;

  /* ---------------------------------------------------------------
     1. TipoPessoa e compatibilidade com o backend legado
     --------------------------------------------------------------- */

  IF COL_LENGTH(N'dbo.Fisioterapeutas', N'TipoPessoa') IS NULL
  BEGIN
    ALTER TABLE dbo.Fisioterapeutas
      ADD TipoPessoa VARCHAR(2) NULL;
  END;

  EXEC sys.sp_executesql N'
UPDATE dbo.Fisioterapeutas
SET TipoPessoa = CASE
  WHEN CPF IS NOT NULL AND LTRIM(RTRIM(CPF)) <> N''''
       AND (CNPJ IS NULL OR LTRIM(RTRIM(CNPJ)) = '''') THEN ''PF''
  WHEN CNPJ IS NOT NULL AND LTRIM(RTRIM(CNPJ)) <> ''''
       AND (CPF IS NULL OR LTRIM(RTRIM(CPF)) = N'''') THEN ''PJ''
  ELSE TipoPessoa
END
WHERE TipoPessoa IS NULL OR LTRIM(RTRIM(TipoPessoa)) = '''';

IF EXISTS (
  SELECT 1
  FROM dbo.Fisioterapeutas
  WHERE
    TipoPessoa NOT IN (''PF'', ''PJ'')
    OR (TipoPessoa = ''PF'' AND (
          CPF IS NULL OR LTRIM(RTRIM(CPF)) = N''''
          OR CNPJ IS NOT NULL
        ))
    OR (TipoPessoa = ''PJ'' AND (
          CNPJ IS NULL OR LTRIM(RTRIM(CNPJ)) = ''''
          OR CPF IS NOT NULL
        ))
)
  THROW 51434, N''V130 bloqueada: existem fisioterapeutas incompatíveis com PF/PJ.'', 1;';

  IF EXISTS (
    SELECT LTRIM(RTRIM(CPF))
    FROM dbo.Pacientes
    WHERE CPF IS NOT NULL AND LTRIM(RTRIM(CPF)) <> N''
    GROUP BY LTRIM(RTRIM(CPF))
    HAVING COUNT_BIG(*) > 1
  )
    THROW 51435, N'V130 bloqueada: existem CPFs duplicados entre pacientes.', 1;

  IF EXISTS (
    SELECT LTRIM(RTRIM(CPF))
    FROM dbo.Fisioterapeutas
    WHERE CPF IS NOT NULL AND LTRIM(RTRIM(CPF)) <> N''
    GROUP BY LTRIM(RTRIM(CPF))
    HAVING COUNT_BIG(*) > 1
  )
    THROW 51436, N'V130 bloqueada: existem CPFs duplicados entre fisioterapeutas.', 1;

  IF EXISTS (
    SELECT 1
    FROM dbo.Pacientes p
    INNER JOIN dbo.Fisioterapeutas f
      ON LTRIM(RTRIM(p.CPF)) = LTRIM(RTRIM(f.CPF))
    WHERE p.CPF IS NOT NULL AND f.CPF IS NOT NULL
  )
    THROW 51437, N'V130 bloqueada: existe CPF compartilhado entre paciente e fisioterapeuta.', 1;

  IF EXISTS (
    SELECT LTRIM(RTRIM(CNPJ))
    FROM dbo.Fisioterapeutas
    WHERE CNPJ IS NOT NULL AND LTRIM(RTRIM(CNPJ)) <> ''
    GROUP BY LTRIM(RTRIM(CNPJ))
    HAVING COUNT_BIG(*) > 1
  )
    THROW 51438, N'V130 bloqueada: existem CNPJs duplicados entre fisioterapeutas.', 1;

  IF EXISTS (
    SELECT 1
    FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID(N'dbo.Fisioterapeutas')
      AND name = N'CK_Fisio_SomentePJ'
  )
  BEGIN
    ALTER TABLE dbo.Fisioterapeutas
      DROP CONSTRAINT CK_Fisio_SomentePJ;
  END;

  IF EXISTS (
    SELECT 1
    FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID(N'dbo.Fisioterapeutas')
      AND name = N'CK_Fisio_CNPJ_Format'
  )
  BEGIN
    ALTER TABLE dbo.Fisioterapeutas
      DROP CONSTRAINT CK_Fisio_CNPJ_Format;
  END;

  IF EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE object_id = OBJECT_ID(N'dbo.Fisioterapeutas')
      AND name = N'UQ_Fisioterapeutas_CNPJ'
      AND has_filter = 0
  )
  BEGIN
    DROP INDEX UQ_Fisioterapeutas_CNPJ
      ON dbo.Fisioterapeutas;
  END;

  IF EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID(N'dbo.Fisioterapeutas')
      AND name = N'CNPJ'
      AND is_nullable = 0
  )
  BEGIN
    ALTER TABLE dbo.Fisioterapeutas
      ALTER COLUMN CNPJ VARCHAR(14) NULL;
  END;

  ALTER TABLE dbo.Fisioterapeutas WITH CHECK
    ADD CONSTRAINT CK_Fisio_CNPJ_Format CHECK (
      CNPJ IS NULL
      OR (
        LEN(CNPJ) = 14
        AND CNPJ COLLATE Latin1_General_BIN2 NOT LIKE '%[^0-9A-Z]%'
        AND RIGHT(CNPJ, 2) COLLATE Latin1_General_BIN2 NOT LIKE '%[^0-9]%'
        AND CNPJ <> '00000000000000'
      )
    );

  ALTER TABLE dbo.Fisioterapeutas
    CHECK CONSTRAINT CK_Fisio_CNPJ_Format;

  IF EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE object_id = OBJECT_ID(N'dbo.Fisioterapeutas')
      AND name = N'UQ_Fisioterapeutas_CNPJ'
      AND (
        has_filter = 0
        OR filter_definition IS NULL
        OR filter_definition NOT LIKE N'%CNPJ%IS NOT NULL%'
      )
  )
  BEGIN
    DROP INDEX UQ_Fisioterapeutas_CNPJ
      ON dbo.Fisioterapeutas;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE object_id = OBJECT_ID(N'dbo.Fisioterapeutas')
      AND name = N'UQ_Fisioterapeutas_CNPJ'
  )
  BEGIN
    CREATE UNIQUE INDEX UQ_Fisioterapeutas_CNPJ
      ON dbo.Fisioterapeutas(CNPJ)
      WHERE CNPJ IS NOT NULL;
  END;

  IF EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE object_id = OBJECT_ID(N'dbo.Fisioterapeutas')
      AND name = N'UQ_Fisioterapeutas_CPF'
      AND (
        is_unique = 0
        OR has_filter = 0
        OR filter_definition IS NULL
        OR filter_definition NOT LIKE N'%CPF%IS NOT NULL%'
      )
  )
  BEGIN
    DROP INDEX UQ_Fisioterapeutas_CPF
      ON dbo.Fisioterapeutas;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE object_id = OBJECT_ID(N'dbo.Fisioterapeutas')
      AND name = N'UQ_Fisioterapeutas_CPF'
  )
  BEGIN
    CREATE UNIQUE INDEX UQ_Fisioterapeutas_CPF
      ON dbo.Fisioterapeutas(CPF)
      WHERE CPF IS NOT NULL;
  END;

  IF EXISTS (
    SELECT 1
    FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID(N'dbo.Fisioterapeutas')
      AND name = N'CK_Fisio_TipoPessoa_Documento'
  )
  BEGIN
    ALTER TABLE dbo.Fisioterapeutas
      DROP CONSTRAINT CK_Fisio_TipoPessoa_Documento;
  END;

  EXEC sys.sp_executesql N'
ALTER TABLE dbo.Fisioterapeutas WITH CHECK
  ADD CONSTRAINT CK_Fisio_TipoPessoa_Documento CHECK (
    (TipoPessoa = ''PF'' AND CPF IS NOT NULL AND CNPJ IS NULL)
    OR
    (TipoPessoa = ''PJ'' AND CPF IS NULL AND CNPJ IS NOT NULL)
  );';

  ALTER TABLE dbo.Fisioterapeutas
    CHECK CONSTRAINT CK_Fisio_TipoPessoa_Documento;

  IF EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID(N'dbo.Fisioterapeutas')
      AND name = N'TipoPessoa'
      AND is_nullable = 1
  )
  BEGIN
    EXEC sys.sp_executesql N'
ALTER TABLE dbo.Fisioterapeutas
  ALTER COLUMN TipoPessoa VARCHAR(2) NOT NULL;';
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM sys.default_constraints dc
    INNER JOIN sys.columns c
      ON c.object_id = dc.parent_object_id
     AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID(N'dbo.Fisioterapeutas')
      AND c.name = N'TipoPessoa'
  )
  BEGIN
    EXEC sys.sp_executesql N'
ALTER TABLE dbo.Fisioterapeutas
  ADD CONSTRAINT DF_Fisioterapeutas_TipoPessoa
  DEFAULT (''PJ'') FOR TipoPessoa;';
  END;

  /* ---------------------------------------------------------------
     2. Registro polimórfico de documentos únicos
     --------------------------------------------------------------- */

  IF OBJECT_ID(N'dbo.UsuariosDocumentosUnicos', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.UsuariosDocumentosUnicos
    (
      DocumentoTipo NVARCHAR(4) NOT NULL,
      DocumentoOriginal NVARCHAR(32) NOT NULL,
      DocumentoNormalizado AS
        UPPER(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(LTRIM(RTRIM(DocumentoOriginal)), N'.', N''),
                N'-', N''
              ),
              N'/', N''
            ),
            N' ', N''
          )
        ) PERSISTED,
      UsuarioTipo NVARCHAR(30) NOT NULL,
      UsuarioId INT NOT NULL,
      CriadoEm DATETIME2(7) NOT NULL
        CONSTRAINT DF_UsuariosDocumentosUnicos_CriadoEm DEFAULT SYSUTCDATETIME(),
      AtualizadoEm DATETIME2(7) NULL,
      CONSTRAINT PK_UsuariosDocumentosUnicos
        PRIMARY KEY CLUSTERED (UsuarioTipo, UsuarioId),
      CONSTRAINT CK_UsuariosDocumentosUnicos_Tipo
        CHECK (DocumentoTipo IN (N'CPF', N'CNPJ')),
      CONSTRAINT CK_UsuariosDocumentosUnicos_UsuarioTipo
        CHECK (UsuarioTipo IN (N'Paciente', N'Fisioterapeuta')),
      CONSTRAINT CK_UsuariosDocumentosUnicos_Formato
        CHECK (
          (
            DocumentoTipo = N'CPF'
            AND LEN(DocumentoNormalizado) = 11
            AND DocumentoNormalizado NOT LIKE N'%[^0-9]%'
          )
          OR
          (
            DocumentoTipo = N'CNPJ'
            AND LEN(DocumentoNormalizado) = 14
            AND DocumentoNormalizado COLLATE Latin1_General_BIN2 NOT LIKE N'%[^0-9A-Z]%'
            AND RIGHT(DocumentoNormalizado, 2) COLLATE Latin1_General_BIN2 NOT LIKE N'%[^0-9]%'
            AND DocumentoNormalizado <> N'00000000000000'
          )
        )
    );
  END;

  IF COL_LENGTH(N'dbo.UsuariosDocumentosUnicos', N'DocumentoTipo') IS NULL
     OR COL_LENGTH(N'dbo.UsuariosDocumentosUnicos', N'DocumentoOriginal') IS NULL
     OR COL_LENGTH(N'dbo.UsuariosDocumentosUnicos', N'DocumentoNormalizado') IS NULL
     OR COL_LENGTH(N'dbo.UsuariosDocumentosUnicos', N'UsuarioTipo') IS NULL
     OR COL_LENGTH(N'dbo.UsuariosDocumentosUnicos', N'UsuarioId') IS NULL
  BEGIN
    THROW 51439, N'V130 bloqueada: dbo.UsuariosDocumentosUnicos possui schema incompatível.', 1;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE object_id = OBJECT_ID(N'dbo.UsuariosDocumentosUnicos')
      AND name = N'UQ_UsuariosDocumentosUnicos_Documento'
  )
  BEGIN
    EXEC sys.sp_executesql N'
CREATE UNIQUE INDEX UQ_UsuariosDocumentosUnicos_Documento
  ON dbo.UsuariosDocumentosUnicos(DocumentoTipo, DocumentoNormalizado);';
  END;

  EXEC sys.sp_executesql N'
MERGE dbo.UsuariosDocumentosUnicos WITH (HOLDLOCK) AS T
USING
(
  SELECT
    CAST(N''CPF'' AS NVARCHAR(4)) AS DocumentoTipo,
    CAST(p.CPF AS NVARCHAR(32)) AS DocumentoOriginal,
    CAST(N''Paciente'' AS NVARCHAR(30)) AS UsuarioTipo,
    p.Id AS UsuarioId
  FROM dbo.Pacientes p
  WHERE p.CPF IS NOT NULL AND LTRIM(RTRIM(p.CPF)) <> N''''

  UNION ALL

  SELECT
    CAST(CASE WHEN f.TipoPessoa = ''PF'' THEN N''CPF'' ELSE N''CNPJ'' END AS NVARCHAR(4)),
    CAST(CASE WHEN f.TipoPessoa = ''PF'' THEN f.CPF ELSE f.CNPJ END AS NVARCHAR(32)),
    CAST(N''Fisioterapeuta'' AS NVARCHAR(30)),
    f.Id
  FROM dbo.Fisioterapeutas f
) AS S
ON T.UsuarioTipo = S.UsuarioTipo
AND T.UsuarioId = S.UsuarioId
WHEN MATCHED AND (
  T.DocumentoTipo <> S.DocumentoTipo
  OR T.DocumentoOriginal <> S.DocumentoOriginal
) THEN
  UPDATE SET
    DocumentoTipo = S.DocumentoTipo,
    DocumentoOriginal = S.DocumentoOriginal,
    AtualizadoEm = SYSUTCDATETIME()
WHEN NOT MATCHED BY TARGET THEN
  INSERT (DocumentoTipo, DocumentoOriginal, UsuarioTipo, UsuarioId)
  VALUES (S.DocumentoTipo, S.DocumentoOriginal, S.UsuarioTipo, S.UsuarioId)
WHEN NOT MATCHED BY SOURCE
     AND T.UsuarioTipo IN (N''Paciente'', N''Fisioterapeuta'') THEN
  DELETE;';

  /* ---------------------------------------------------------------
     3. Triggers para concorrência e inserções fora da API
     --------------------------------------------------------------- */

  EXEC sys.sp_executesql N'
CREATE OR ALTER TRIGGER dbo.TR_Pacientes_DocumentoUnico
ON dbo.Pacientes
AFTER INSERT, UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;

  DELETE U
  FROM dbo.UsuariosDocumentosUnicos U
  INNER JOIN deleted d
    ON U.UsuarioTipo = N''Paciente''
   AND U.UsuarioId = d.Id
  WHERE NOT EXISTS (SELECT 1 FROM inserted i WHERE i.Id = d.Id);

  MERGE dbo.UsuariosDocumentosUnicos WITH (HOLDLOCK) AS T
  USING
  (
    SELECT
      CAST(N''CPF'' AS NVARCHAR(4)) AS DocumentoTipo,
      CAST(i.CPF AS NVARCHAR(32)) AS DocumentoOriginal,
      CAST(N''Paciente'' AS NVARCHAR(30)) AS UsuarioTipo,
      i.Id AS UsuarioId
    FROM inserted i
    WHERE i.CPF IS NOT NULL AND LTRIM(RTRIM(i.CPF)) <> N''''
  ) AS S
  ON T.UsuarioTipo = S.UsuarioTipo
 AND T.UsuarioId = S.UsuarioId
  WHEN MATCHED AND (
    T.DocumentoTipo <> S.DocumentoTipo
    OR T.DocumentoOriginal <> S.DocumentoOriginal
  ) THEN
    UPDATE SET
      DocumentoTipo = S.DocumentoTipo,
      DocumentoOriginal = S.DocumentoOriginal,
      AtualizadoEm = SYSUTCDATETIME()
  WHEN NOT MATCHED BY TARGET THEN
    INSERT (DocumentoTipo, DocumentoOriginal, UsuarioTipo, UsuarioId)
    VALUES (S.DocumentoTipo, S.DocumentoOriginal, S.UsuarioTipo, S.UsuarioId);
END;';

  EXEC sys.sp_executesql N'
CREATE OR ALTER TRIGGER dbo.TR_Fisioterapeutas_DocumentoUnico
ON dbo.Fisioterapeutas
AFTER INSERT, UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;

  DELETE U
  FROM dbo.UsuariosDocumentosUnicos U
  INNER JOIN deleted d
    ON U.UsuarioTipo = N''Fisioterapeuta''
   AND U.UsuarioId = d.Id
  WHERE NOT EXISTS (SELECT 1 FROM inserted i WHERE i.Id = d.Id);

  MERGE dbo.UsuariosDocumentosUnicos WITH (HOLDLOCK) AS T
  USING
  (
    SELECT
      CAST(CASE WHEN i.TipoPessoa = ''PF'' THEN N''CPF'' ELSE N''CNPJ'' END AS NVARCHAR(4)) AS DocumentoTipo,
      CAST(CASE WHEN i.TipoPessoa = ''PF'' THEN i.CPF ELSE i.CNPJ END AS NVARCHAR(32)) AS DocumentoOriginal,
      CAST(N''Fisioterapeuta'' AS NVARCHAR(30)) AS UsuarioTipo,
      i.Id AS UsuarioId
    FROM inserted i
  ) AS S
  ON T.UsuarioTipo = S.UsuarioTipo
 AND T.UsuarioId = S.UsuarioId
  WHEN MATCHED AND (
    T.DocumentoTipo <> S.DocumentoTipo
    OR T.DocumentoOriginal <> S.DocumentoOriginal
  ) THEN
    UPDATE SET
      DocumentoTipo = S.DocumentoTipo,
      DocumentoOriginal = S.DocumentoOriginal,
      AtualizadoEm = SYSUTCDATETIME()
  WHEN NOT MATCHED BY TARGET THEN
    INSERT (DocumentoTipo, DocumentoOriginal, UsuarioTipo, UsuarioId)
    VALUES (S.DocumentoTipo, S.DocumentoOriginal, S.UsuarioTipo, S.UsuarioId);
END;';

  /* ---------------------------------------------------------------
     4. Login por e-mail e CPF unificado
     --------------------------------------------------------------- */

  EXEC sys.sp_executesql N'
CREATE OR ALTER PROCEDURE dbo.sp_LoginPorEmail_Min
  @Email NVARCHAR(300)
AS
BEGIN
  SET NOCOUNT ON;

  DECLARE @EmailNorm NVARCHAR(300) = LOWER(LTRIM(RTRIM(@Email)));

  SELECT
    N''Admin'' AS Tipo,
    a.Id,
    a.Nome,
    a.Email,
    a.SenhaHash,
    CAST(a.Ativo AS INT) AS Ativo,
    CAST(0 AS INT) AS IsBloqueado,
    CAST(NULL AS NVARCHAR(20)) AS Cpf,
    CAST(NULL AS NVARCHAR(20)) AS Cnpj
  FROM dbo.Administradores a
  WHERE LOWER(LTRIM(RTRIM(a.Email))) = @EmailNorm

  UNION ALL

  SELECT
    N''Fisioterapeuta'' AS Tipo,
    f.Id,
    f.Nome,
    f.Email,
    f.SenhaHash,
    CAST(f.Ativo AS INT) AS Ativo,
    CAST(ISNULL(f.IsBloqueado, 0) AS INT) AS IsBloqueado,
    CAST(f.CPF AS NVARCHAR(20)) AS Cpf,
    CAST(f.CNPJ AS NVARCHAR(20)) AS Cnpj
  FROM dbo.Fisioterapeutas f
  WHERE LOWER(LTRIM(RTRIM(f.Email))) = @EmailNorm

  UNION ALL

  SELECT
    N''Paciente'' AS Tipo,
    p.Id,
    p.Nome,
    p.Email,
    p.SenhaHash,
    CAST(p.Ativo AS INT) AS Ativo,
    CAST(ISNULL(p.IsBloqueado, 0) AS INT) AS IsBloqueado,
    CAST(p.CPF AS NVARCHAR(20)) AS Cpf,
    CAST(NULL AS NVARCHAR(20)) AS Cnpj
  FROM dbo.Pacientes p
  WHERE LOWER(LTRIM(RTRIM(p.Email))) = @EmailNorm;
END;';

  EXEC sys.sp_executesql N'
CREATE OR ALTER PROCEDURE dbo.sp_LoginPorCpf_Min
  @Cpf NVARCHAR(32)
AS
BEGIN
  SET NOCOUNT ON;

  DECLARE @CpfNormalizado NVARCHAR(32) =
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(LTRIM(RTRIM(ISNULL(@Cpf, N''''))), N''.'', N''''),
          N''-'', N''''
        ),
        N''/'', N''''
      ),
      N'' '', N''''
    );

  SELECT
    N''Fisioterapeuta'' AS Tipo,
    f.Id,
    f.Nome,
    f.Email,
    f.SenhaHash,
    CAST(f.Ativo AS INT) AS Ativo,
    CAST(ISNULL(f.IsBloqueado, 0) AS INT) AS IsBloqueado,
    CAST(f.CPF AS NVARCHAR(20)) AS Cpf,
    CAST(NULL AS NVARCHAR(20)) AS Cnpj
  FROM dbo.UsuariosDocumentosUnicos u
  INNER JOIN dbo.Fisioterapeutas f
    ON u.UsuarioTipo = N''Fisioterapeuta''
   AND u.UsuarioId = f.Id
  WHERE u.DocumentoTipo = N''CPF''
    AND u.DocumentoNormalizado = @CpfNormalizado

  UNION ALL

  SELECT
    N''Paciente'' AS Tipo,
    p.Id,
    p.Nome,
    p.Email,
    p.SenhaHash,
    CAST(p.Ativo AS INT) AS Ativo,
    CAST(ISNULL(p.IsBloqueado, 0) AS INT) AS IsBloqueado,
    CAST(p.CPF AS NVARCHAR(20)) AS Cpf,
    CAST(NULL AS NVARCHAR(20)) AS Cnpj
  FROM dbo.UsuariosDocumentosUnicos u
  INNER JOIN dbo.Pacientes p
    ON u.UsuarioTipo = N''Paciente''
   AND u.UsuarioId = p.Id
  WHERE u.DocumentoTipo = N''CPF''
    AND u.DocumentoNormalizado = @CpfNormalizado;
END;';

  /* ---------------------------------------------------------------
     5. Pré-cadastro de paciente com CPF global
     --------------------------------------------------------------- */

  EXEC sys.sp_executesql N'
CREATE OR ALTER PROCEDURE dbo.SP_Fisio_PreCadastrarPaciente
  @FisioterapeutaId       INT,
  @Nome                   NVARCHAR(300),
  @CPF                    NVARCHAR(40),
  @Email                  NVARCHAR(300),
  @Telefone               NVARCHAR(60),
  @SenhaHash              NVARCHAR(256),
  @DataNascimento         DATE           = NULL,
  @Cidade                 NVARCHAR(400)  = NULL,
  @Estado                 NVARCHAR(400)  = NULL,
  @Naturalidade           NVARCHAR(240)  = NULL,
  @EstadoCivil            NVARCHAR(120)  = NULL,
  @Genero                 NVARCHAR(40)   = NULL,
  @Profissao              NVARCHAR(240)  = NULL,
  @EnderecoComercial      NVARCHAR(1600) = NULL,
  @EnderecoResidencial    NVARCHAR(1600) = NULL,
  @BairroComercial        NVARCHAR(200)  = NULL,
  @BairroResidencial      NVARCHAR(200)  = NULL,
  @Cep                    NVARCHAR(18)   = NULL,
  @ObservacoesVinculo     NVARCHAR(400)  = NULL,
  @CPFValido              BIT            = 0,
  @ComplementoResidencial NVARCHAR(400)  = NULL
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  BEGIN TRY
    BEGIN TRAN;

    DECLARE @CtxTipo NVARCHAR(40) = CAST(SESSION_CONTEXT(N''UsuarioTipo'') AS NVARCHAR(40));
    DECLARE @CtxId INT = TRY_CONVERT(INT, SESSION_CONTEXT(N''UsuarioId''));
    DECLARE @CpfNormalizado NVARCHAR(40) =
      REPLACE(REPLACE(REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(@CPF, N''''))), N''.'', N''''), N''-'', N''''), N''/'', N''''), N'' '', N'''');

    IF (@CtxTipo IS NOT NULL AND @CtxTipo <> N''Admin'')
    BEGIN
      IF (@CtxTipo <> N''Fisioterapeuta'' OR @CtxId IS NULL OR @CtxId <> @FisioterapeutaId)
        RAISERROR(N''Acesso negado para pré-cadastro de paciente.'', 16, 1);
    END;

    IF NOT EXISTS (SELECT 1 FROM dbo.Fisioterapeutas WHERE Id = @FisioterapeutaId)
      RAISERROR(N''FisioterapeutaId inválido.'', 16, 1);

    IF LEN(@CpfNormalizado) <> 11 OR @CpfNormalizado LIKE N''%[^0-9]%''
      RAISERROR(N''CPF inválido.'', 16, 1);

    IF EXISTS (
      SELECT 1
      FROM dbo.UsuariosDocumentosUnicos
      WHERE DocumentoTipo = N''CPF''
        AND DocumentoNormalizado = @CpfNormalizado
    )
      RAISERROR(N''Já existe usuário cadastrado com este CPF.'', 16, 1);

    IF EXISTS (SELECT 1 FROM dbo.Pacientes WHERE Email = @Email)
      RAISERROR(N''Já existe paciente cadastrado com este Email.'', 16, 1);

    INSERT INTO dbo.Pacientes
    (
      Nome, CPF, Email, Telefone, DataNascimento, SenhaHash, Ativo,
      TipoCadastro, OrigemCadastro, CPFValido, IsBloqueado, Cidade,
      Estado, Naturalidade, EstadoCivil, Genero, Profissao,
      EnderecoComercial, EnderecoResidencial, BairroComercial,
      BairroResidencial, Cep, ComplementoResidencial
    )
    VALUES
    (
      @Nome, @CpfNormalizado, @Email, @Telefone, @DataNascimento,
      @SenhaHash, 1, N''Email'', N''PreCadastroFisio'', @CPFValido, 0,
      @Cidade, @Estado, @Naturalidade, @EstadoCivil, @Genero, @Profissao,
      @EnderecoComercial, @EnderecoResidencial,
      NULLIF(LTRIM(RTRIM(ISNULL(@BairroComercial, N''''))), N''''),
      NULLIF(LTRIM(RTRIM(ISNULL(@BairroResidencial, N''''))), N''''),
      @Cep,
      NULLIF(LTRIM(RTRIM(ISNULL(@ComplementoResidencial, N''''))), N'''')
    );

    DECLARE @PacienteId INT = CAST(SCOPE_IDENTITY() AS INT);

    INSERT INTO dbo.FisioPacientesCarteira
    (
      PacienteId, FisioterapeutaId, Observacoes,
      IsentoTaxaServico, IsentoIntermediacao, Ativo
    )
    VALUES
    (
      @PacienteId, @FisioterapeutaId, @ObservacoesVinculo, 1, 1, 1
    );

    COMMIT;

    SELECT
      CAST(1 AS BIT) AS Sucesso,
      N''Paciente pré-cadastrado e vínculo criado.'' AS Mensagem,
      @PacienteId AS PacienteId,
      @FisioterapeutaId AS FisioterapeutaId;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
    RAISERROR(@Err, 16, 1);
  END CATCH
END;';

  /* ---------------------------------------------------------------
     6. Perfil público sem exposição de CPF completo
     --------------------------------------------------------------- */

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
      f.CNPJ,
      f.TipoPessoa,
      CASE WHEN f.TipoPessoa = ''PF'' THEN N''CPF'' ELSE N''CNPJ'' END
        AS DocumentoProfissionalTipo,
      CASE
        WHEN f.TipoPessoa = ''PF'' AND LEN(f.CPF) = 11
          THEN CONCAT(N''***.***.***-'', RIGHT(f.CPF, 2))
        WHEN f.TipoPessoa = ''PJ'' AND LEN(f.CNPJ) = 14
          THEN CONCAT(N''**.***.***/****-'', RIGHT(f.CNPJ, 2))
        ELSE NULL
      END AS DocumentoProfissionalMascarado,
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
    LEFT JOIN dbo.Fisioterapeutas f
      ON f.Id = v.FisioterapeutaId
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

  /* ---------------------------------------------------------------
     7. Pós-condições da migration
     --------------------------------------------------------------- */

  EXEC sys.sp_executesql N'
IF EXISTS (
  SELECT 1
  FROM dbo.Fisioterapeutas
  WHERE
    (TipoPessoa = ''PF'' AND (CPF IS NULL OR CNPJ IS NOT NULL))
    OR (TipoPessoa = ''PJ'' AND (CPF IS NOT NULL OR CNPJ IS NULL))
)
  THROW 51440, N''V130 falhou: pós-condição PF/PJ inválida.'', 1;

IF (SELECT COUNT_BIG(*) FROM dbo.UsuariosDocumentosUnicos)
   < (SELECT COUNT_BIG(*) FROM dbo.Pacientes)
     + (SELECT COUNT_BIG(*) FROM dbo.Fisioterapeutas)
  THROW 51441, N''V130 falhou: registro global de documentos incompleto.'', 1;';

  IF OBJECT_ID(N'dbo.sp_LoginPorCpf_Min', N'P') IS NULL
    THROW 51442, N'V130 falhou: dbo.sp_LoginPorCpf_Min não foi criada.', 1;

  IF @DryRun = 1
  BEGIN
    ROLLBACK TRANSACTION;
    SELECT
      N'DRY_RUN_OK' AS MigrationStatus,
      DB_NAME() AS DatabaseName,
      N'V130' AS MigrationVersion;
  END
  ELSE
  BEGIN
    COMMIT TRANSACTION;
    SELECT
      N'APPLIED' AS MigrationStatus,
      DB_NAME() AS DatabaseName,
      N'V130' AS MigrationVersion;
  END;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0
    ROLLBACK TRANSACTION;
  THROW;
END CATCH;
