/*
  V124 - Corrige timezone do fluxo de token/check-in no Azure SQL.

  Problema:
  - Azure SQL retorna UTC em SYSDATETIME()/GETDATE().
  - O check-in era gravado pelo backend com horario Brasil, mas:
    * dbo.SP_GerarTokenValidacaoConsulta gravava TokenGeradoEm com SYSDATETIME()
    * dbo.SP_ValidarTokenConsulta comparava/grava validacao com SYSDATETIME()
    * dbo.trg_ValidacoesAtendimento_Validado gravava DataEncerramento com SYSDATETIME()
  - Resultado: TokenGeradoEm/DataEncerramento ficavam +3h em HML/PROD Azure.
*/

CREATE OR ALTER PROCEDURE dbo.SP_GerarTokenValidacaoConsulta
  @ConsultaId INT,
  @PacienteId INT,
  @MinutosExpiracao INT = 10
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  BEGIN TRY
    BEGIN TRAN;

    DECLARE
      @Status NVARCHAR(60),
      @StatusPagamento NVARCHAR(100),
      @TokenAtual NVARCHAR(16),
      @TokenGeradoEm DATETIME2(7),
      @AgoraBrasil DATETIME2(7) =
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7));

    SELECT
      @Status = LTRIM(RTRIM(ISNULL(c.Status, N''))),
      @StatusPagamento = LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))),
      @TokenAtual = c.TokenValidacao,
      @TokenGeradoEm = c.TokenGeradoEm
    FROM dbo.Consultas c
    WHERE c.Id = @ConsultaId
      AND c.PacienteId = @PacienteId;

    IF @Status IS NULL
    BEGIN
      RAISERROR(N'Consulta nao encontrada para este paciente.', 16, 1);
      ROLLBACK; RETURN;
    END

    IF @Status <> N'Confirmada'
    BEGIN
      RAISERROR(N'Consulta precisa estar em Status=Confirmada para gerar token.', 16, 1);
      ROLLBACK; RETURN;
    END

    IF @StatusPagamento <> N'Pago'
    BEGIN
      RAISERROR(N'Consulta precisa estar paga (StatusPagamento=Pago) para gerar token.', 16, 1);
      ROLLBACK; RETURN;
    END

    ;WITH x AS (
      SELECT
        va.Id,
        ROW_NUMBER() OVER (PARTITION BY va.ConsultaId ORDER BY va.Id DESC) AS rn
      FROM dbo.ValidacoesAtendimento va
      WHERE va.ConsultaId = @ConsultaId
    )
    DELETE FROM x WHERE rn > 1;

    IF @TokenAtual IS NOT NULL
       AND @TokenGeradoEm IS NOT NULL
       AND DATEADD(MINUTE, @MinutosExpiracao, @TokenGeradoEm) > @AgoraBrasil
       AND EXISTS (
         SELECT 1
         FROM dbo.ValidacoesAtendimento va
         WHERE va.ConsultaId = @ConsultaId
           AND va.Token = @TokenAtual
           AND ISNULL(va.Validado, 0) = 0
           AND ISNULL(va.TentativasInvalidas, 0) < ISNULL(va.MaxTentativas, 3)
       )
    BEGIN
      COMMIT;

      SELECT
        CAST(1 AS bit) AS Sucesso,
        N'Token existente ainda valido.' AS Mensagem,
        @ConsultaId AS ConsultaId,
        @TokenAtual AS TokenValidacao,
        @TokenGeradoEm AS TokenGeradoEm,
        DATEADD(MINUTE, @MinutosExpiracao, @TokenGeradoEm) AS TokenExpiraEm;

      RETURN;
    END

    DECLARE @Tentativas INT = 0;
    DECLARE @TokenNovo NVARCHAR(6) = NULL;

    WHILE @Tentativas < 25
    BEGIN
      SET @TokenNovo = RIGHT(N'000000' + CONVERT(NVARCHAR(6), ABS(CHECKSUM(NEWID())) % 1000000), 6);

      IF NOT EXISTS (SELECT 1 FROM dbo.ValidacoesAtendimento WHERE Token = @TokenNovo)
        BREAK;

      SET @Tentativas += 1;
    END

    IF @TokenNovo IS NULL OR @Tentativas >= 25
    BEGIN
      RAISERROR(N'Falha ao gerar token unico. Tente novamente.', 16, 1);
      ROLLBACK; RETURN;
    END

    UPDATE dbo.Consultas
    SET TokenValidacao = @TokenNovo,
        TokenGeradoEm = @AgoraBrasil
    WHERE Id = @ConsultaId
      AND PacienteId = @PacienteId;

    IF EXISTS (SELECT 1 FROM dbo.ValidacoesAtendimento WHERE ConsultaId = @ConsultaId)
    BEGIN
      UPDATE dbo.ValidacoesAtendimento
      SET Token = @TokenNovo,
          Validado = 0,
          DataValidacao = NULL,
          TentativasInvalidas = 0,
          MaxTentativas = CASE WHEN ISNULL(MaxTentativas, 0) <= 0 THEN 3 ELSE MaxTentativas END,
          UltimaTentativaInvalidaEm = NULL
      WHERE ConsultaId = @ConsultaId;
    END
    ELSE
    BEGIN
      INSERT INTO dbo.ValidacoesAtendimento
      (
        ConsultaId,
        Token,
        Validado,
        DataValidacao,
        TentativasInvalidas,
        MaxTentativas,
        UltimaTentativaInvalidaEm
      )
      VALUES
      (
        @ConsultaId,
        @TokenNovo,
        0,
        NULL,
        0,
        3,
        NULL
      );
    END

    COMMIT;

    SELECT
      CAST(1 AS bit) AS Sucesso,
      N'Token gerado.' AS Mensagem,
      @ConsultaId AS ConsultaId,
      @TokenNovo AS TokenValidacao,
      @AgoraBrasil AS TokenGeradoEm,
      DATEADD(MINUTE, @MinutosExpiracao, @AgoraBrasil) AS TokenExpiraEm;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
    RAISERROR(@ErrMsg, 16, 1);
  END CATCH
END;
GO

CREATE OR ALTER PROCEDURE dbo.SP_ValidarTokenConsulta
  @ConsultaId INT,
  @FisioterapeutaId INT,
  @TokenDigitado NVARCHAR(16),
  @MinutosExpiracao INT = 10
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  BEGIN TRY
    BEGIN TRAN;

    DECLARE
      @Status NVARCHAR(60),
      @StatusPagamento NVARCHAR(100),
      @TokenEsperado NVARCHAR(16),
      @TokenGeradoEm DATETIME2(7),
      @TentativasInvalidas SMALLINT,
      @MaxTentativas SMALLINT,
      @TentativasAposErro SMALLINT,
      @AgoraBrasil DATETIME2(7) =
        CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7));

    SELECT
      @Status = LTRIM(RTRIM(ISNULL(c.Status, N''))),
      @StatusPagamento = LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))),
      @TokenEsperado = c.TokenValidacao,
      @TokenGeradoEm = c.TokenGeradoEm
    FROM dbo.Consultas c
    WHERE c.Id = @ConsultaId
      AND c.FisioterapeutaId = @FisioterapeutaId;

    IF @Status IS NULL
    BEGIN
      RAISERROR(N'Consulta nao encontrada para este fisioterapeuta.', 16, 1);
      ROLLBACK; RETURN;
    END

    SET @TokenDigitado = LTRIM(RTRIM(ISNULL(@TokenDigitado, N'')));

    IF @TokenDigitado NOT LIKE N'[0-9][0-9][0-9][0-9][0-9][0-9]'
    BEGIN
      RAISERROR(N'TokenDigitado invalido (esperado 6 digitos).', 16, 1);
      ROLLBACK; RETURN;
    END

    IF @StatusPagamento <> N'Pago'
    BEGIN
      RAISERROR(N'Consulta nao esta paga (StatusPagamento <> Pago).', 16, 1);
      ROLLBACK; RETURN;
    END

    IF @Status <> N'Confirmada'
    BEGIN
      RAISERROR(N'Consulta precisa estar em Status=Confirmada para validar token.', 16, 1);
      ROLLBACK; RETURN;
    END

    IF @TokenEsperado IS NULL OR @TokenGeradoEm IS NULL
    BEGIN
      RAISERROR(N'Token nao foi gerado para esta consulta.', 16, 1);
      ROLLBACK; RETURN;
    END

    IF DATEADD(MINUTE, @MinutosExpiracao, @TokenGeradoEm) <= @AgoraBrasil
    BEGIN
      RAISERROR(N'Token expirado. Solicite um novo token ao paciente.', 16, 1);
      ROLLBACK; RETURN;
    END

    ;WITH x AS (
      SELECT
        va.Id,
        ROW_NUMBER() OVER (PARTITION BY va.ConsultaId ORDER BY va.Id DESC) AS rn
      FROM dbo.ValidacoesAtendimento va
      WHERE va.ConsultaId = @ConsultaId
    )
    DELETE FROM x WHERE rn > 1;

    IF NOT EXISTS (SELECT 1 FROM dbo.ValidacoesAtendimento WHERE ConsultaId = @ConsultaId)
    BEGIN
      INSERT INTO dbo.ValidacoesAtendimento
      (
        ConsultaId,
        Token,
        Validado,
        DataValidacao,
        TentativasInvalidas,
        MaxTentativas,
        UltimaTentativaInvalidaEm
      )
      VALUES
      (
        @ConsultaId,
        @TokenEsperado,
        0,
        NULL,
        0,
        3,
        NULL
      );
    END

    SELECT
      @TentativasInvalidas = ISNULL(va.TentativasInvalidas, 0),
      @MaxTentativas = CASE WHEN ISNULL(va.MaxTentativas, 0) <= 0 THEN 3 ELSE va.MaxTentativas END
    FROM dbo.ValidacoesAtendimento va WITH (UPDLOCK, HOLDLOCK)
    WHERE va.ConsultaId = @ConsultaId;

    IF EXISTS (
      SELECT 1
      FROM dbo.ValidacoesAtendimento
      WHERE ConsultaId = @ConsultaId
        AND Token = @TokenEsperado
        AND ISNULL(Validado, 0) = 1
    )
    BEGIN
      COMMIT;

      SELECT
        CAST(1 AS bit) AS Sucesso,
        N'Token ja havia sido validado.' AS Mensagem,
        @ConsultaId AS ConsultaId;

      RETURN;
    END

    IF ISNULL(@TentativasInvalidas, 0) >= ISNULL(@MaxTentativas, 3)
    BEGIN
      RAISERROR(N'Limite de tentativas excedido. Solicite um novo token ao paciente.', 16, 1);
      ROLLBACK; RETURN;
    END

    IF @TokenDigitado <> LTRIM(RTRIM(@TokenEsperado))
    BEGIN
      ROLLBACK;

      BEGIN TRAN;

      IF NOT EXISTS (
        SELECT 1
        FROM dbo.ValidacoesAtendimento WITH (UPDLOCK, HOLDLOCK)
        WHERE ConsultaId = @ConsultaId
      )
      BEGIN
        INSERT INTO dbo.ValidacoesAtendimento
        (
          ConsultaId,
          Token,
          Validado,
          DataValidacao,
          TentativasInvalidas,
          MaxTentativas,
          UltimaTentativaInvalidaEm
        )
        VALUES
        (
          @ConsultaId,
          @TokenEsperado,
          0,
          NULL,
          0,
          3,
          NULL
        );
      END

      UPDATE dbo.ValidacoesAtendimento
      SET TentativasInvalidas = ISNULL(TentativasInvalidas, 0) + 1,
          UltimaTentativaInvalidaEm = @AgoraBrasil
      WHERE ConsultaId = @ConsultaId;

      SELECT
        @TentativasAposErro = TentativasInvalidas,
        @MaxTentativas = CASE WHEN ISNULL(MaxTentativas, 0) <= 0 THEN 3 ELSE MaxTentativas END
      FROM dbo.ValidacoesAtendimento
      WHERE ConsultaId = @ConsultaId;

      COMMIT;

      IF ISNULL(@TentativasAposErro, 0) > ISNULL(@MaxTentativas, 3)
      BEGIN
        RAISERROR(N'Limite de tentativas excedido. Solicite um novo token ao paciente.', 16, 1);
        RETURN;
      END

      RAISERROR(N'Token invalido. Tentativa %d de %d.', 16, 1, @TentativasAposErro, @MaxTentativas);
      RETURN;
    END

    UPDATE dbo.ValidacoesAtendimento
    SET Validado = 1,
        DataValidacao = ISNULL(DataValidacao, @AgoraBrasil)
    WHERE ConsultaId = @ConsultaId
      AND Token = @TokenEsperado
      AND ISNULL(Validado, 0) <> 1;

    IF @@ROWCOUNT = 0
    BEGIN
      RAISERROR(N'Falha ao validar token. Tente novamente.', 16, 1);
      ROLLBACK; RETURN;
    END

    COMMIT;

    SELECT
      CAST(1 AS bit) AS Sucesso,
      N'Token validado. A conclusao/encerramento ocorrera via triggers.' AS Mensagem,
      @ConsultaId AS ConsultaId;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
    RAISERROR(@ErrMsg, 16, 1);
  END CATCH
END;
GO

CREATE OR ALTER TRIGGER dbo.trg_ValidacoesAtendimento_Validado
ON dbo.ValidacoesAtendimento
AFTER INSERT, UPDATE
AS
BEGIN
  SET NOCOUNT ON;

  IF TRIGGER_NESTLEVEL() > 1 RETURN;

  BEGIN TRY
    DECLARE @Quando DATETIME2(7) =
      CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'E. South America Standard Time' AS DATETIME2(7));

    --------------------------------------------------------------------
    -- 1) Detecta transicao real para Validado = 1
    --------------------------------------------------------------------
    DECLARE @Validados TABLE (ConsultaId INT PRIMARY KEY);

    INSERT INTO @Validados (ConsultaId)
    SELECT DISTINCT i.ConsultaId
    FROM inserted i
    LEFT JOIN deleted d ON d.Id = i.Id
    WHERE ISNULL(i.Validado, 0) = 1
      AND ISNULL(d.Validado, 0) <> 1;

    IF NOT EXISTS (SELECT 1 FROM @Validados)
      RETURN;

    --------------------------------------------------------------------
    -- 1.1) Elegiveis para concluir: somente se consulta ainda esta Confirmada
    --      (Regra: NAO pode reverter "Paciente Ausente")
    --------------------------------------------------------------------
    DECLARE @Elegiveis TABLE (ConsultaId INT PRIMARY KEY);

    INSERT INTO @Elegiveis (ConsultaId)
    SELECT v.ConsultaId
    FROM @Validados v
    JOIN dbo.Consultas c ON c.Id = v.ConsultaId
    WHERE LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Confirmada'
      AND ISNULL(c.ConfirmacaoAtendimento, 0) = 0;

    --------------------------------------------------------------------
    -- 2) Preenche DataValidacao apenas para elegiveis
    --------------------------------------------------------------------
    UPDATE va
    SET va.DataValidacao = ISNULL(va.DataValidacao, @Quando)
    FROM dbo.ValidacoesAtendimento va
    JOIN inserted i ON i.Id = va.Id
    JOIN @Elegiveis e ON e.ConsultaId = i.ConsultaId
    WHERE ISNULL(i.Validado, 0) = 1
      AND va.DataValidacao IS NULL;

    --------------------------------------------------------------------
    -- 3) Atualiza a Consulta: conclui + encerra + bloqueia chat
    --    SOMENTE se estava Confirmada (nao reverte Paciente Ausente)
    --------------------------------------------------------------------
    DECLARE @Concluidas TABLE (ConsultaId INT PRIMARY KEY, PacienteId INT);

    UPDATE c
    SET
      c.ConfirmacaoAtendimento = 1,
      c.Status = N'Concluída',
      c.ChatLiberado = 0,
      c.DataEncerramento = ISNULL(c.DataEncerramento, @Quando),
      c.MotivoEncerramento = ISNULL(c.MotivoEncerramento, N'Atendimento confirmado pelo paciente')
    OUTPUT inserted.Id, inserted.PacienteId
    INTO @Concluidas (ConsultaId, PacienteId)
    FROM dbo.Consultas c
    JOIN @Elegiveis e ON e.ConsultaId = c.Id;

    IF NOT EXISTS (SELECT 1 FROM @Concluidas)
    BEGIN
      -- Auditoria: tentativa de validar token fora do estado permitido.
      INSERT INTO dbo.AuditoriaTriggersLogs
        (TabelaAfetada, Acao, RegistroId, UsuarioSistema, MensagemDetalhe)
      SELECT
        N'dbo.ValidacoesAtendimento',
        N'Validado=1 ignorado (status nao permite concluir)',
        v.ConsultaId,
        SUSER_SNAME(),
        CONCAT(N'Validado=1 em ', CONVERT(nvarchar(19), @Quando, 120),
               N'. Ignorado: consulta nao esta Confirmada (nao reverte Paciente Ausente). Status atual=',
               LTRIM(RTRIM(ISNULL(c.Status, N''))), N'.')
      FROM @Validados v
      JOIN dbo.Consultas c ON c.Id = v.ConsultaId;

      RETURN;
    END

    --------------------------------------------------------------------
    -- 4) Inativa chat(s) ativo(s) da consulta (somente concluidas)
    --------------------------------------------------------------------
    UPDATE ca
    SET ca.Ativo = 0
    FROM dbo.ChatsAtivos ca
    JOIN @Concluidas x ON x.ConsultaId = ca.ConsultaId
    WHERE ca.Ativo = 1;

    --------------------------------------------------------------------
    -- 5) ConsultasLogs (evento do paciente) (somente concluidas)
    --------------------------------------------------------------------
    INSERT INTO dbo.ConsultasLogs
      (ConsultaId, Evento, Descricao, Latitude, Longitude, UsuarioTipo, UsuarioId)
    SELECT
      x.ConsultaId,
      N'TokenValidado',
      N'Atendimento confirmado pelo paciente (Validado=1). Consulta concluída e chat encerrado.',
      NULL, NULL,
      N'Paciente',
      x.PacienteId
    FROM @Concluidas x;

    --------------------------------------------------------------------
    -- 6) AuditoriaTriggersLogs (somente concluidas)
    --------------------------------------------------------------------
    INSERT INTO dbo.AuditoriaTriggersLogs
      (TabelaAfetada, Acao, RegistroId, UsuarioSistema, MensagemDetalhe)
    SELECT
      N'dbo.ValidacoesAtendimento',
      N'Validado=1 -> ConcluirConsulta',
      x.ConsultaId,
      SUSER_SNAME(),
      CONCAT(N'Validado=1 em ', CONVERT(nvarchar(19), @Quando, 120),
             N'. Consulta concluída, chat bloqueado e encerramento registrado.')
    FROM @Concluidas x;
  END TRY
  BEGIN CATCH
    DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();

    INSERT INTO dbo.AuditoriaTriggersLogs
      (TabelaAfetada, Acao, RegistroId, UsuarioSistema, MensagemDetalhe)
    VALUES
      (N'dbo.ValidacoesAtendimento', N'ERRO', NULL, SUSER_SNAME(),
       CONCAT(N'Erro na trg_ValidacoesAtendimento_Validado: ', @Err));

    RAISERROR(@Err, 16, 1);
  END CATCH
END;
GO

SELECT
  CAST(1 AS bit) AS Sucesso,
  N'AZURE_TIMEZONE_TOKEN_VALIDACAO_V124 aplicado.' AS Mensagem;
GO
