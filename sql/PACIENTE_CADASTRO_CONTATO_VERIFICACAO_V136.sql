/*
  V136 - Pré-validação de e-mail e telefone no cadastro de pacientes.
*/

SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRAN;

  IF OBJECT_ID(N'dbo.PacienteCadastroSessoes', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.PacienteCadastroSessoes
    (
      Id UNIQUEIDENTIFIER NOT NULL,
      NomeInformado NVARCHAR(300) NOT NULL,
      CPFNormalizado NVARCHAR(20) NOT NULL,
      EmailNormalizado NVARCHAR(300) NOT NULL,
      TelefoneNormalizado NVARCHAR(20) NOT NULL,
      Status NVARCHAR(30) NOT NULL CONSTRAINT DF_PacienteCadastroSessoes_Status DEFAULT (N'EmAndamento'),
      ExpiraEm DATETIME2(7) NOT NULL,
      ContatosConfirmadosEm DATETIME2(7) NULL,
      ConsumidoEm DATETIME2(7) NULL,
      PacienteId INT NULL,
      CriadoEm DATETIME2(7) NOT NULL CONSTRAINT DF_PacienteCadastroSessoes_CriadoEm DEFAULT (SYSDATETIME()),
      AtualizadoEm DATETIME2(7) NOT NULL CONSTRAINT DF_PacienteCadastroSessoes_AtualizadoEm DEFAULT (SYSDATETIME()),
      RowVersion ROWVERSION NOT NULL,
      CONSTRAINT PK_PacienteCadastroSessoes PRIMARY KEY CLUSTERED (Id),
      CONSTRAINT CK_PacienteCadastroSessoes_Status CHECK (
        Status IN (N'EmAndamento', N'ContatosConfirmados', N'Consumido', N'Expirado', N'Cancelado')
      ),
      CONSTRAINT CK_PacienteCadastroSessoes_Consumo CHECK (
        (Status <> N'Consumido' AND ConsumidoEm IS NULL AND PacienteId IS NULL)
        OR (Status = N'Consumido' AND ConsumidoEm IS NOT NULL AND PacienteId IS NOT NULL)
      )
    );
  END;

  IF OBJECT_ID(N'dbo.PacienteCadastroVerificacoes', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.PacienteCadastroVerificacoes
    (
      Id BIGINT IDENTITY(1,1) NOT NULL,
      CadastroSessaoId UNIQUEIDENTIFIER NOT NULL,
      Canal NVARCHAR(20) NOT NULL,
      DestinoNormalizado NVARCHAR(300) NOT NULL,
      CodigoHash VARBINARY(32) NULL,
      CodigoSalt VARBINARY(16) NULL,
      Tentativas SMALLINT NOT NULL CONSTRAINT DF_PacienteCadastroVerificacoes_Tentativas DEFAULT (0),
      MaxTentativas SMALLINT NOT NULL CONSTRAINT DF_PacienteCadastroVerificacoes_MaxTentativas DEFAULT (5),
      Status NVARCHAR(20) NOT NULL CONSTRAINT DF_PacienteCadastroVerificacoes_Status DEFAULT (N'Pendente'),
      ExpiraEm DATETIME2(7) NULL,
      UltimoEnvioEm DATETIME2(7) NULL,
      ConfirmadoEm DATETIME2(7) NULL,
      OrigemConfirmacao NVARCHAR(20) NULL,
      CriadoEm DATETIME2(7) NOT NULL CONSTRAINT DF_PacienteCadastroVerificacoes_CriadoEm DEFAULT (SYSDATETIME()),
      AtualizadoEm DATETIME2(7) NOT NULL CONSTRAINT DF_PacienteCadastroVerificacoes_AtualizadoEm DEFAULT (SYSDATETIME()),
      RowVersion ROWVERSION NOT NULL,
      CONSTRAINT PK_PacienteCadastroVerificacoes PRIMARY KEY CLUSTERED (Id),
      CONSTRAINT FK_PacienteCadastroVerificacoes_Sessao FOREIGN KEY (CadastroSessaoId)
        REFERENCES dbo.PacienteCadastroSessoes(Id),
      CONSTRAINT UQ_PacienteCadastroVerificacoes_SessaoCanal UNIQUE (CadastroSessaoId, Canal),
      CONSTRAINT CK_PacienteCadastroVerificacoes_Canal CHECK (Canal IN (N'Email', N'Telefone')),
      CONSTRAINT CK_PacienteCadastroVerificacoes_Status CHECK (
        Status IN (N'Pendente', N'Confirmado', N'Expirado', N'Bloqueado', N'Cancelado')
      ),
      CONSTRAINT CK_PacienteCadastroVerificacoes_Tentativas CHECK (
        Tentativas >= 0 AND MaxTentativas BETWEEN 1 AND 20
      ),
      CONSTRAINT CK_PacienteCadastroVerificacoes_Confirmacao CHECK (
        (Status = N'Confirmado' AND ConfirmadoEm IS NOT NULL AND OrigemConfirmacao IN (N'Codigo', N'OAuth'))
        OR (Status <> N'Confirmado' AND ConfirmadoEm IS NULL AND OrigemConfirmacao IS NULL)
      )
    );
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = N'IX_PacienteCadastroSessoes_EmailStatusExpira'
      AND object_id = OBJECT_ID(N'dbo.PacienteCadastroSessoes')
  )
  BEGIN
    CREATE INDEX IX_PacienteCadastroSessoes_EmailStatusExpira
      ON dbo.PacienteCadastroSessoes (EmailNormalizado, Status, ExpiraEm DESC)
      INCLUDE (TelefoneNormalizado, CPFNormalizado);
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = N'IX_PacienteCadastroSessoes_TelefoneStatusExpira'
      AND object_id = OBJECT_ID(N'dbo.PacienteCadastroSessoes')
  )
  BEGIN
    CREATE INDEX IX_PacienteCadastroSessoes_TelefoneStatusExpira
      ON dbo.PacienteCadastroSessoes (TelefoneNormalizado, Status, ExpiraEm DESC)
      INCLUDE (EmailNormalizado, CPFNormalizado);
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = N'IX_PacienteCadastroSessoes_StatusAtualizado'
      AND object_id = OBJECT_ID(N'dbo.PacienteCadastroSessoes')
  )
  BEGIN
    CREATE INDEX IX_PacienteCadastroSessoes_StatusAtualizado
      ON dbo.PacienteCadastroSessoes (Status, AtualizadoEm, Id);
  END;

  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = N'IX_PacienteCadastroVerificacoes_DestinoCanal'
      AND object_id = OBJECT_ID(N'dbo.PacienteCadastroVerificacoes')
  )
  BEGIN
    CREATE INDEX IX_PacienteCadastroVerificacoes_DestinoCanal
      ON dbo.PacienteCadastroVerificacoes (DestinoNormalizado, Canal, CriadoEm DESC)
      INCLUDE (Status, ExpiraEm, UltimoEnvioEm);
  END;

  COMMIT;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  THROW;
END CATCH;

EXEC(N'
CREATE OR ALTER PROCEDURE dbo.SP_LimparCadastrosPacientePendentes
  @RetencaoExpiradosDias INT = 7,
  @RetencaoConsumidosDias INT = 30
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  IF @RetencaoExpiradosDias < 1 OR @RetencaoExpiradosDias > 90
    THROW 50301, N''RETENCAO_EXPIRADOS_INVALIDA'', 1;

  IF @RetencaoConsumidosDias < 1 OR @RetencaoConsumidosDias > 365
    THROW 50302, N''RETENCAO_CONSUMIDOS_INVALIDA'', 1;

  DECLARE @SessoesExpiradas INT = 0;
  DECLARE @VerificacoesExpiradas INT = 0;
  DECLARE @VerificacoesExcluidas INT = 0;
  DECLARE @SessoesExcluidas INT = 0;

  BEGIN TRAN;

  UPDATE dbo.PacienteCadastroSessoes
  SET Status = N''Expirado'', AtualizadoEm = SYSDATETIME()
  WHERE Status IN (N''EmAndamento'', N''ContatosConfirmados'')
    AND ExpiraEm <= SYSDATETIME();
  SET @SessoesExpiradas = @@ROWCOUNT;

  UPDATE v
  SET Status = CASE WHEN s.Status = N''Cancelado'' THEN N''Cancelado'' ELSE N''Expirado'' END,
      AtualizadoEm = SYSDATETIME(), CodigoHash = NULL, CodigoSalt = NULL
  FROM dbo.PacienteCadastroVerificacoes v
  INNER JOIN dbo.PacienteCadastroSessoes s ON s.Id = v.CadastroSessaoId
  WHERE v.Status IN (N''Pendente'', N''Bloqueado'')
    AND (s.Status IN (N''Expirado'', N''Cancelado'', N''Consumido'') OR v.ExpiraEm <= SYSDATETIME());
  SET @VerificacoesExpiradas = @@ROWCOUNT;

  DELETE v
  FROM dbo.PacienteCadastroVerificacoes v
  INNER JOIN dbo.PacienteCadastroSessoes s ON s.Id = v.CadastroSessaoId
  WHERE (s.Status IN (N''Expirado'', N''Cancelado'')
         AND s.AtualizadoEm < DATEADD(DAY, -@RetencaoExpiradosDias, SYSDATETIME()))
     OR (s.Status = N''Consumido''
         AND s.ConsumidoEm < DATEADD(DAY, -@RetencaoConsumidosDias, SYSDATETIME()));
  SET @VerificacoesExcluidas = @@ROWCOUNT;

  DELETE FROM dbo.PacienteCadastroSessoes
  WHERE (Status IN (N''Expirado'', N''Cancelado'')
         AND AtualizadoEm < DATEADD(DAY, -@RetencaoExpiradosDias, SYSDATETIME()))
     OR (Status = N''Consumido''
         AND ConsumidoEm < DATEADD(DAY, -@RetencaoConsumidosDias, SYSDATETIME()));
  SET @SessoesExcluidas = @@ROWCOUNT;

  COMMIT;

  SELECT @SessoesExpiradas AS SessoesExpiradas,
         @VerificacoesExpiradas AS VerificacoesExpiradas,
         @VerificacoesExcluidas AS VerificacoesExcluidas,
         @SessoesExcluidas AS SessoesExcluidas;
END;
');

SELECT CAST(1 AS BIT) AS Sucesso,
       N'PACIENTE_CADASTRO_CONTATO_VERIFICACAO_V136 aplicado.' AS Mensagem;
