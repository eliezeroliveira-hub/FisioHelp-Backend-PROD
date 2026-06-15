import { sql } from '../config/dbConfig.js';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { queryWithContext } from './_queryWithContext.js';
import { asaasClient } from './asaasClient.js';
import notificacoesDispatch from './notificacoesDispatch.js';

const STATUS_LOTE_ATIVO = ['Processando', 'EnviadoGateway', 'AguardandoConfirmacao'];
const STATUS_TRANSFER_DONE = new Set(['DONE']);
const STATUS_TRANSFER_FALHA = new Set(['FAILED', 'CANCELLED', 'CANCELED', 'REFUSED']);

function systemUser() {
  return { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
}

function safeUser(usuario) {
  if (usuario?.tipo && usuario?.id) return usuario;
  return systemUser();
}

function toInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function toMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function text(value, max = 500) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeStatus(value) {
  return String(value ?? '').trim().toUpperCase();
}

function getTransferId(transfer) {
  return text(
    transfer?.id ??
      transfer?.transferId ??
      transfer?.transfer_id ??
      transfer?.object?.id,
    80
  );
}

function getTransferStatus(transfer) {
  return text(
    transfer?.status ??
      transfer?.transferStatus ??
      transfer?.transfer_status,
    40
  );
}

function getTransferFee(transfer) {
  return toMoney(
    transfer?.transferFee ??
      transfer?.fee ??
      transfer?.transfer_fee
  );
}

function getReceiptUrl(transfer) {
  return text(
    transfer?.transactionReceiptUrl ??
      transfer?.receiptUrl ??
      transfer?.receipt_url ??
      transfer?.bankSlipUrl,
    500
  );
}

function getTransferExternalReference(transfer) {
  return text(
    transfer?.externalReference ??
      transfer?.external_reference,
    80
  );
}

function getLoteIdFromExternalReference(value) {
  const match = String(value ?? '').trim().match(/^REPASSE_(\d+)$/i);
  if (!match) return null;
  return toInt(match[1]);
}

function buildDescricaoLote(lote) {
  return text(`Repasse FisioHelp lote ${lote.Id}`, 140);
}

function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function isValidCNPJ(value) {
  const cnpj = onlyDigits(value);
  if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;

  const calcDigit = (base, weights) => {
    const sum = weights.reduce((acc, weight, index) => acc + Number(base[index]) * weight, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  const firstDigit = calcDigit(cnpj, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const secondDigit = calcDigit(cnpj, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return firstDigit === Number(cnpj[12]) && secondDigit === Number(cnpj[13]);
}

function getValidCnpj(lote) {
  const cnpj = onlyDigits(lote?.CNPJ);
  if (isValidCNPJ(cnpj)) return cnpj;
  return null;
}

function hasPixDestination(lote) {
  return Boolean(text(lote?.ChavePix, 140) && text(lote?.TipoChavePix, 20));
}

function getMetodoTransferencia(lote) {
  return hasPixDestination(lote) ? 'PIX' : 'TED';
}

function parseBankCode(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/\d{3}/);
  return match ? match[0] : null;
}

function parseAccount(value) {
  const raw = String(value ?? '').trim();
  const parts = raw.toUpperCase().split('-');
  if (parts.length >= 2 && parts[0]) {
    const account = parts.slice(0, -1).join('');
    const digit = parts[parts.length - 1] || '';
    return {
      account: onlyDigits(account),
      accountDigit: digit.replace(/[^0-9X]/g, '').slice(0, 1) || null,
    };
  }

  return {
    account: onlyDigits(raw),
    accountDigit: null,
  };
}

function normalizeBankAccountType(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw.includes('poup')) return 'CONTA_POUPANCA';
  return 'CONTA_CORRENTE';
}

function buildBankAccountTransferPayload(lote) {
  const bankCode = parseBankCode(lote.Banco);
  const agency = onlyDigits(lote.Agencia);
  const { account, accountDigit } = parseAccount(lote.Conta);
  const cpfCnpj = getValidCnpj(lote);
  const ownerName = text(lote.NomeFisioterapeuta ?? lote.Nome, 100);

  if (!bankCode || !agency || !account || !accountDigit || !cpfCnpj || !ownerName) {
    throw new Error('Dados bancários do fisioterapeuta incompletos: banco, agência, conta com dígito, titular e CNPJ válido são obrigatórios para repasse TED.');
  }

  const bankAccount = {
    bank: { code: bankCode },
    ownerName,
    cpfCnpj,
    agency,
    account,
    bankAccountType: normalizeBankAccountType(lote.TipoContaBancaria),
  };

  if (accountDigit) {
    bankAccount.accountDigit = accountDigit;
  }

  return {
    value: toMoney(lote.ValorTransferencia),
    bankAccount,
    operationType: 'TED',
    externalReference: `REPASSE_${lote.Id}`,
  };
}

function buildAsaasTransferPayload(lote) {
  if (!hasPixDestination(lote)) {
    return buildBankAccountTransferPayload(lote);
  }

  return {
    value: toMoney(lote.ValorTransferencia),
    operationType: 'PIX',
    pixAddressKey: text(lote.ChavePix, 140),
    pixAddressKeyType: text(lote.TipoChavePix, 20),
    description: buildDescricaoLote(lote),
    externalReference: `REPASSE_${lote.Id}`,
  };
}

function isDone(status) {
  return STATUS_TRANSFER_DONE.has(normalizeStatus(status));
}

function isFalha(status) {
  return STATUS_TRANSFER_FALHA.has(normalizeStatus(status));
}

function eventoTransferenciaFinal(event) {
  const normalized = normalizeStatus(event);
  if (normalized === 'TRANSFER_DONE') return 'DONE';
  if (['TRANSFER_FAILED', 'TRANSFER_CANCELLED', 'TRANSFER_CANCELED'].includes(normalized)) return 'FAILED';
  return null;
}

const repassesGatewayService = {
  async estruturaDisponivel(usuario = null) {
    const ctx = safeUser(usuario);
    const result = await queryWithContext(ctx, () => {}, `
      SELECT CASE
        WHEN OBJECT_ID(N'dbo.LotesRepassesGateway', N'U') IS NULL THEN 0
        WHEN OBJECT_ID(N'dbo.LoteRepassesGatewayItens', N'U') IS NULL THEN 0
        WHEN OBJECT_ID(N'dbo.LoteRepassesGatewayAjustes', N'U') IS NULL THEN 0
        WHEN COL_LENGTH(N'dbo.Fisioterapeutas', N'ChavePix') IS NULL THEN 0
        WHEN COL_LENGTH(N'dbo.LotesRepassesGateway', N'MetodoTransferencia') IS NULL THEN 0
        WHEN COL_LENGTH(N'dbo.LotesRepassesGateway', N'ValorTarifaTransferencia') IS NULL THEN 0
        WHEN COL_LENGTH(N'dbo.LotesRepassesGateway', N'TarifaTransferenciaDescricao') IS NULL THEN 0
        WHEN COL_LENGTH(N'dbo.LotesRepassesGateway', N'GatewayTransferFee') IS NULL THEN 0
        ELSE 1
      END AS Disponivel;
    `);

    return Number(result?.recordset?.[0]?.Disponivel ?? 0) === 1;
  },

  async recuperarProcessandoTravado({ staleMinutes = 10 } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    const minutes = Math.max(1, Number(staleMinutes) || 10);

    const result = await queryWithContext(ctx, (req) => {
      req.input('StaleMinutes', sql.Int, minutes);
    }, `
      SET NOCOUNT ON;

      DECLARE @Recuperados TABLE (Id INT PRIMARY KEY);

      UPDATE dbo.LotesRepassesGateway
      SET Status = N'FalhaTemporaria',
          AtivoGateway = 0,
          ProcessandoEm = NULL,
          ProximaTentativaEm = SYSDATETIME(),
          GatewayErroMensagem = N'Worker interrompido ou processamento excedeu o tempo limite.',
          GatewayUltimoEvento = N'FISIOHELP_TRANSFER_WORKER_STALE',
          AtualizadoEm = SYSDATETIME()
      OUTPUT INSERTED.Id INTO @Recuperados (Id)
      WHERE Status = N'Processando'
        AND ProcessandoEm < DATEADD(MINUTE, -@StaleMinutes, SYSDATETIME());

      UPDATE i
      SET StatusItem = N'Falha',
          AtivoGatewayItem = 0,
          AtualizadoEm = SYSDATETIME()
      FROM dbo.LoteRepassesGatewayItens i
      JOIN @Recuperados r ON r.Id = i.LoteId
      WHERE i.StatusItem = N'Reservado';

      UPDATE a
      SET StatusAjuste = N'Falha',
          AtivoGatewayAjuste = 0,
          AtualizadoEm = SYSDATETIME()
      FROM dbo.LoteRepassesGatewayAjustes a
      JOIN @Recuperados r ON r.Id = a.LoteId
      WHERE a.StatusAjuste = N'Reservado';

      SELECT COUNT(*) AS Recuperados FROM @Recuperados;
    `);

    return Number(result?.recordset?.[0]?.Recuperados ?? 0);
  },

  async claimProximo({ limitRepasses = 50, maxAttempts = 8 } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    const result = await queryWithContext(ctx, (req) => {
      req.input('LimitRepasses', sql.Int, Math.max(1, Math.min(Number(limitRepasses) || 50, 200)));
      req.input('MaxAttempts', sql.Int, Math.max(1, Math.min(Number(maxAttempts) || 8, 50)));
      req.input('UsuarioRegistro', sql.NVarChar(200), text(`${ctx.tipo}:${ctx.id}`, 200));
    }, `
      SET NOCOUNT ON;
      SET XACT_ABORT ON;

      BEGIN TRY
        BEGIN TRAN;

        DECLARE @LoteId INT = NULL;
        DECLARE @FisioId INT = NULL;
        DECLARE @ValorBruto DECIMAL(10,2) = 0;
        DECLARE @ValorAjustes DECIMAL(10,2) = 0;
        DECLARE @ValorDisponivel DECIMAL(10,2) = 0;
        DECLARE @MetodoTransferencia NVARCHAR(20) = NULL;
        DECLARE @ValorTarifaTransferencia DECIMAL(10,2) = 0;
        DECLARE @RepasseTarifaPix DECIMAL(10,2) = NULL;
        DECLARE @RepasseTarifaTed DECIMAL(10,2) = NULL;
        DECLARE @RepasseValorMinimoTransferencia DECIMAL(10,2) = NULL;
        DECLARE @SkipFisioId INT = NULL;
        DECLARE @SkipValorDisponivel DECIMAL(10,2) = NULL;
        DECLARE @SkipTarifa DECIMAL(10,2) = NULL;
        DECLARE @SkipMinimo DECIMAL(10,2) = NULL;
        DECLARE @SkipMetodo NVARCHAR(20) = NULL;
        DECLARE @SkipMotivo NVARCHAR(120) = NULL;

        SELECT TOP (1) @RepasseTarifaPix = ValorDecimal
        FROM dbo.ParametrosSistema WITH (READCOMMITTEDLOCK)
        WHERE Nome = N'RepasseTarifaPix' AND Ativo = 1
        ORDER BY Id DESC;

        SELECT TOP (1) @RepasseTarifaTed = ValorDecimal
        FROM dbo.ParametrosSistema WITH (READCOMMITTEDLOCK)
        WHERE Nome = N'RepasseTarifaTed' AND Ativo = 1
        ORDER BY Id DESC;

        SELECT TOP (1) @RepasseValorMinimoTransferencia = ValorDecimal
        FROM dbo.ParametrosSistema WITH (READCOMMITTEDLOCK)
        WHERE Nome = N'RepasseValorMinimoTransferencia' AND Ativo = 1
        ORDER BY Id DESC;

        IF @RepasseTarifaPix IS NULL
          THROW 51060, N'Parâmetro RepasseTarifaPix não configurado.', 1;
        IF @RepasseTarifaTed IS NULL
          THROW 51061, N'Parâmetro RepasseTarifaTed não configurado.', 1;
        IF @RepasseValorMinimoTransferencia IS NULL
          THROW 51062, N'Parâmetro RepasseValorMinimoTransferencia não configurado.', 1;

        SELECT TOP (1) @LoteId = l.Id
        FROM dbo.LotesRepassesGateway l WITH (UPDLOCK, HOLDLOCK)
        WHERE l.Status = N'FalhaTemporaria'
          AND l.Tentativas < @MaxAttempts
          AND (l.ProximaTentativaEm IS NULL OR l.ProximaTentativaEm <= SYSDATETIME())
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.LotesRepassesGateway ativo WITH (UPDLOCK, HOLDLOCK)
            WHERE ativo.FisioterapeutaId = l.FisioterapeutaId
              AND ativo.Id <> l.Id
              AND ativo.Status IN (N'Processando', N'EnviadoGateway', N'AguardandoConfirmacao')
          )
        ORDER BY COALESCE(l.ProximaTentativaEm, l.CriadoEm), l.Id;

        IF @LoteId IS NOT NULL
        BEGIN
          UPDATE dbo.LotesRepassesGateway
          SET Status = N'Processando',
              AtivoGateway = 1,
              ProcessandoEm = SYSDATETIME(),
              Tentativas = CASE WHEN Tentativas < 255 THEN Tentativas + 1 ELSE Tentativas END,
              GatewayErroMensagem = NULL,
              GatewayUltimoEvento = N'FISIOHELP_TRANSFER_RETRY',
              AtualizadoEm = SYSDATETIME()
          WHERE Id = @LoteId;

          UPDATE dbo.LoteRepassesGatewayItens
          SET StatusItem = N'Reservado',
              AtivoGatewayItem = 1,
              AtualizadoEm = SYSDATETIME()
          WHERE LoteId = @LoteId
            AND StatusItem = N'Falha';

          UPDATE dbo.LoteRepassesGatewayAjustes
          SET StatusAjuste = N'Reservado',
              AtivoGatewayAjuste = 1,
              AtualizadoEm = SYSDATETIME()
          WHERE LoteId = @LoteId
            AND StatusAjuste = N'Falha';
        END
        ELSE
        BEGIN
          ;WITH RepassesElegiveis AS (
            SELECT
              r.Id,
              r.FisioterapeutaId,
              r.DataPrevista,
              CAST(r.ValorLiquido AS DECIMAL(10,2)) AS ValorRepasse,
              CASE
                WHEN NULLIF(LTRIM(RTRIM(ISNULL(f.ChavePix, N''))), N'') IS NOT NULL
                 AND NULLIF(LTRIM(RTRIM(ISNULL(f.TipoChavePix, N''))), N'') IS NOT NULL
                  THEN N'PIX'
                ELSE N'TED'
              END AS MetodoTransferencia
            FROM dbo.Repasses r WITH (UPDLOCK, HOLDLOCK)
            JOIN dbo.Fisioterapeutas f WITH (UPDLOCK, HOLDLOCK)
              ON f.Id = r.FisioterapeutaId
            WHERE LTRIM(RTRIM(ISNULL(r.Status, N''))) = N'Pendente'
              AND r.DataPrevista <= SYSDATETIME()
              AND r.ValorLiquido > 0
              AND (
                (
                  NULLIF(LTRIM(RTRIM(ISNULL(f.ChavePix, N''))), N'') IS NOT NULL
                  AND NULLIF(LTRIM(RTRIM(ISNULL(f.TipoChavePix, N''))), N'') IS NOT NULL
                )
                OR (
                  NULLIF(LTRIM(RTRIM(ISNULL(f.Banco, N''))), N'') IS NOT NULL
                  AND NULLIF(LTRIM(RTRIM(ISNULL(f.Agencia, N''))), N'') IS NOT NULL
                  AND NULLIF(LTRIM(RTRIM(ISNULL(f.Conta, N''))), N'') IS NOT NULL
                  AND NULLIF(LTRIM(RTRIM(ISNULL(f.TipoContaBancaria, N''))), N'') IS NOT NULL
                  AND NULLIF(LTRIM(RTRIM(ISNULL(f.CNPJ, N''))), N'') IS NOT NULL
                )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM dbo.LoteRepassesGatewayItens i WITH (UPDLOCK, HOLDLOCK)
                WHERE i.RepasseId = r.Id
                  AND i.StatusItem IN (N'Reservado', N'EnviadoGateway')
              )
              AND NOT EXISTS (
                SELECT 1
                FROM dbo.LotesRepassesGateway l WITH (UPDLOCK, HOLDLOCK)
                WHERE l.FisioterapeutaId = r.FisioterapeutaId
                  AND l.Status IN (N'Processando', N'EnviadoGateway', N'AguardandoConfirmacao', N'FalhaTemporaria')
              )
          ),
          RepassesLimitados AS (
            SELECT *
            FROM (
              SELECT
                e.*,
                ROW_NUMBER() OVER (PARTITION BY e.FisioterapeutaId ORDER BY e.DataPrevista, e.Id) AS rn
              FROM RepassesElegiveis e
            ) ranked
            WHERE rn <= @LimitRepasses
          ),
          Brutos AS (
            SELECT
              FisioterapeutaId,
              MIN(DataPrevista) AS PrimeiraData,
              MAX(MetodoTransferencia) AS MetodoTransferencia,
              CAST(SUM(ValorRepasse) AS DECIMAL(10,2)) AS ValorBruto
            FROM RepassesLimitados
            GROUP BY FisioterapeutaId
          ),
          Ajustes AS (
            SELECT
              ar.FisioterapeutaId,
              CAST(SUM(ar.ValorPendente) AS DECIMAL(10,2)) AS ValorPendente
            FROM dbo.AjustesRepasses ar WITH (UPDLOCK, HOLDLOCK)
            WHERE LTRIM(RTRIM(ISNULL(ar.Status, N''))) = N'Pendente'
              AND ar.ValorPendente > 0
              AND NOT EXISTS (
                SELECT 1
                FROM dbo.LoteRepassesGatewayAjustes la WITH (UPDLOCK, HOLDLOCK)
                WHERE la.AjusteRepasseId = ar.Id
                  AND la.StatusAjuste IN (N'Reservado', N'EnviadoGateway')
              )
            GROUP BY ar.FisioterapeutaId
          ),
          Candidatos AS (
            SELECT
              b.FisioterapeutaId,
              b.PrimeiraData,
              b.MetodoTransferencia,
              b.ValorBruto,
              CAST(CASE
                WHEN ISNULL(a.ValorPendente, 0) >= b.ValorBruto THEN b.ValorBruto
                ELSE ISNULL(a.ValorPendente, 0)
              END AS DECIMAL(10,2)) AS ValorAjustesAplicaveis,
              CAST(b.ValorBruto - CASE
                WHEN ISNULL(a.ValorPendente, 0) >= b.ValorBruto THEN b.ValorBruto
                ELSE ISNULL(a.ValorPendente, 0)
              END AS DECIMAL(10,2)) AS ValorDisponivel,
              CAST(CASE WHEN b.MetodoTransferencia = N'PIX' THEN @RepasseTarifaPix ELSE @RepasseTarifaTed END AS DECIMAL(10,2)) AS Tarifa
            FROM Brutos b
            LEFT JOIN Ajustes a ON a.FisioterapeutaId = b.FisioterapeutaId
          ),
          Elegiveis AS (
            SELECT *
            FROM Candidatos
            WHERE ValorDisponivel <= 0
               OR (
                 ValorDisponivel > Tarifa
                 AND CAST(ValorDisponivel - Tarifa AS DECIMAL(10,2)) >= @RepasseValorMinimoTransferencia
               )
          )
          SELECT TOP (1)
            @FisioId = FisioterapeutaId,
            @MetodoTransferencia = MetodoTransferencia,
            @ValorTarifaTransferencia = CASE WHEN ValorDisponivel <= 0 THEN 0 ELSE Tarifa END
          FROM Elegiveis
          ORDER BY PrimeiraData, FisioterapeutaId;

          IF @FisioId IS NULL
          BEGIN
            ;WITH RepassesElegiveis AS (
              SELECT
                r.Id,
                r.FisioterapeutaId,
                r.DataPrevista,
                CAST(r.ValorLiquido AS DECIMAL(10,2)) AS ValorRepasse,
                CASE
                  WHEN NULLIF(LTRIM(RTRIM(ISNULL(f.ChavePix, N''))), N'') IS NOT NULL
                   AND NULLIF(LTRIM(RTRIM(ISNULL(f.TipoChavePix, N''))), N'') IS NOT NULL
                    THEN N'PIX'
                  ELSE N'TED'
                END AS MetodoTransferencia
              FROM dbo.Repasses r WITH (READCOMMITTEDLOCK)
              JOIN dbo.Fisioterapeutas f WITH (READCOMMITTEDLOCK)
                ON f.Id = r.FisioterapeutaId
              WHERE LTRIM(RTRIM(ISNULL(r.Status, N''))) = N'Pendente'
                AND r.DataPrevista <= SYSDATETIME()
                AND r.ValorLiquido > 0
                AND (
                  (
                    NULLIF(LTRIM(RTRIM(ISNULL(f.ChavePix, N''))), N'') IS NOT NULL
                    AND NULLIF(LTRIM(RTRIM(ISNULL(f.TipoChavePix, N''))), N'') IS NOT NULL
                  )
                  OR (
                    NULLIF(LTRIM(RTRIM(ISNULL(f.Banco, N''))), N'') IS NOT NULL
                    AND NULLIF(LTRIM(RTRIM(ISNULL(f.Agencia, N''))), N'') IS NOT NULL
                    AND NULLIF(LTRIM(RTRIM(ISNULL(f.Conta, N''))), N'') IS NOT NULL
                    AND NULLIF(LTRIM(RTRIM(ISNULL(f.TipoContaBancaria, N''))), N'') IS NOT NULL
                    AND NULLIF(LTRIM(RTRIM(ISNULL(f.CNPJ, N''))), N'') IS NOT NULL
                  )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM dbo.LoteRepassesGatewayItens i WITH (READCOMMITTEDLOCK)
                  WHERE i.RepasseId = r.Id
                    AND i.StatusItem IN (N'Reservado', N'EnviadoGateway')
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM dbo.LotesRepassesGateway l WITH (READCOMMITTEDLOCK)
                  WHERE l.FisioterapeutaId = r.FisioterapeutaId
                    AND l.Status IN (N'Processando', N'EnviadoGateway', N'AguardandoConfirmacao', N'FalhaTemporaria')
                )
            ),
            RepassesLimitados AS (
              SELECT *
              FROM (
                SELECT
                  e.*,
                  ROW_NUMBER() OVER (PARTITION BY e.FisioterapeutaId ORDER BY e.DataPrevista, e.Id) AS rn
                FROM RepassesElegiveis e
              ) ranked
              WHERE rn <= @LimitRepasses
            ),
            Brutos AS (
              SELECT
                FisioterapeutaId,
                MIN(DataPrevista) AS PrimeiraData,
                MAX(MetodoTransferencia) AS MetodoTransferencia,
                CAST(SUM(ValorRepasse) AS DECIMAL(10,2)) AS ValorBruto
              FROM RepassesLimitados
              GROUP BY FisioterapeutaId
            ),
            Ajustes AS (
              SELECT
                ar.FisioterapeutaId,
                CAST(SUM(ar.ValorPendente) AS DECIMAL(10,2)) AS ValorPendente
              FROM dbo.AjustesRepasses ar WITH (READCOMMITTEDLOCK)
              WHERE LTRIM(RTRIM(ISNULL(ar.Status, N''))) = N'Pendente'
                AND ar.ValorPendente > 0
                AND NOT EXISTS (
                  SELECT 1
                  FROM dbo.LoteRepassesGatewayAjustes la WITH (READCOMMITTEDLOCK)
                  WHERE la.AjusteRepasseId = ar.Id
                    AND la.StatusAjuste IN (N'Reservado', N'EnviadoGateway')
                )
              GROUP BY ar.FisioterapeutaId
            ),
            Candidatos AS (
              SELECT
                b.FisioterapeutaId,
                b.PrimeiraData,
                b.MetodoTransferencia,
                CAST(b.ValorBruto - CASE
                  WHEN ISNULL(a.ValorPendente, 0) >= b.ValorBruto THEN b.ValorBruto
                  ELSE ISNULL(a.ValorPendente, 0)
                END AS DECIMAL(10,2)) AS ValorDisponivel,
                CAST(CASE WHEN b.MetodoTransferencia = N'PIX' THEN @RepasseTarifaPix ELSE @RepasseTarifaTed END AS DECIMAL(10,2)) AS Tarifa
              FROM Brutos b
              LEFT JOIN Ajustes a ON a.FisioterapeutaId = b.FisioterapeutaId
            ),
            Skips AS (
              SELECT *,
                CASE
                  WHEN ValorDisponivel <= Tarifa THEN N'Valor disponível não cobre a tarifa de transferência.'
                  WHEN CAST(ValorDisponivel - Tarifa AS DECIMAL(10,2)) < @RepasseValorMinimoTransferencia THEN N'Valor líquido abaixo do mínimo de transferência.'
                  ELSE NULL
                END AS Motivo
              FROM Candidatos
              WHERE ValorDisponivel > 0
                AND (
                  ValorDisponivel <= Tarifa
                  OR CAST(ValorDisponivel - Tarifa AS DECIMAL(10,2)) < @RepasseValorMinimoTransferencia
                )
            )
            SELECT TOP (1)
              @SkipFisioId = FisioterapeutaId,
              @SkipValorDisponivel = ValorDisponivel,
              @SkipTarifa = Tarifa,
              @SkipMinimo = @RepasseValorMinimoTransferencia,
              @SkipMetodo = MetodoTransferencia,
              @SkipMotivo = Motivo
            FROM Skips
            ORDER BY PrimeiraData, FisioterapeutaId;
          END

          IF @FisioId IS NOT NULL
          BEGIN
            INSERT INTO dbo.LotesRepassesGateway
              (FisioterapeutaId, Status, AtivoGateway, GatewayProvider, Tentativas, ProcessandoEm, ProximaTentativaEm, UsuarioRegistro)
            VALUES
              (@FisioId, N'Processando', 1, N'asaas', 1, SYSDATETIME(), SYSDATETIME(), @UsuarioRegistro);

            SET @LoteId = CONVERT(INT, SCOPE_IDENTITY());

            ;WITH RepassesCandidatos AS (
              SELECT TOP (@LimitRepasses)
                r.Id,
                r.FisioterapeutaId,
                r.TransacaoId,
                CAST(r.ValorLiquido AS DECIMAL(10,2)) AS ValorRepasse
              FROM dbo.Repasses r WITH (UPDLOCK, HOLDLOCK)
              WHERE r.FisioterapeutaId = @FisioId
                AND LTRIM(RTRIM(ISNULL(r.Status, N''))) = N'Pendente'
                AND r.DataPrevista <= SYSDATETIME()
                AND r.ValorLiquido > 0
                AND NOT EXISTS (
                  SELECT 1
                  FROM dbo.LoteRepassesGatewayItens i WITH (UPDLOCK, HOLDLOCK)
                  WHERE i.RepasseId = r.Id
                    AND i.StatusItem IN (N'Reservado', N'EnviadoGateway')
                )
              ORDER BY r.DataPrevista, r.Id
            )
            INSERT INTO dbo.LoteRepassesGatewayItens
              (LoteId, RepasseId, FisioterapeutaId, TransacaoId, ValorRepasse, ValorTransferidoItem, StatusItem, AtivoGatewayItem)
            SELECT
              @LoteId,
              rc.Id,
              rc.FisioterapeutaId,
              rc.TransacaoId,
              rc.ValorRepasse,
              rc.ValorRepasse,
              N'Reservado',
              1
            FROM RepassesCandidatos rc;

            IF NOT EXISTS (SELECT 1 FROM dbo.LoteRepassesGatewayItens WHERE LoteId = @LoteId)
            BEGIN
              UPDATE dbo.LotesRepassesGateway
              SET Status = N'Cancelado',
                  AtivoGateway = 0,
                  GatewayErroMensagem = N'Nenhum repasse elegível encontrado após claim.',
                  AtualizadoEm = SYSDATETIME()
              WHERE Id = @LoteId;

              SET @LoteId = NULL;
            END
            ELSE
            BEGIN
              SELECT @ValorBruto = CAST(ISNULL(SUM(ValorRepasse), 0) AS DECIMAL(10,2))
              FROM dbo.LoteRepassesGatewayItens
              WHERE LoteId = @LoteId;

              ;WITH AjustesOrdenados AS (
                SELECT
                  ar.Id,
                  ar.FisioterapeutaId,
                  ar.TransacaoId,
                  ar.ConsultaId,
                  CAST(ar.ValorPendente AS DECIMAL(10,2)) AS ValorPendente,
                  CAST(SUM(ar.ValorPendente) OVER (ORDER BY ar.CriadoEm, ar.Id ROWS UNBOUNDED PRECEDING) AS DECIMAL(10,2)) AS Acumulado
                FROM dbo.AjustesRepasses ar WITH (UPDLOCK, HOLDLOCK)
                WHERE ar.FisioterapeutaId = @FisioId
                  AND LTRIM(RTRIM(ISNULL(ar.Status, N''))) = N'Pendente'
                  AND ar.ValorPendente > 0
                  AND NOT EXISTS (
                    SELECT 1
                    FROM dbo.LoteRepassesGatewayAjustes la WITH (UPDLOCK, HOLDLOCK)
                    WHERE la.AjusteRepasseId = ar.Id
                      AND la.StatusAjuste IN (N'Reservado', N'EnviadoGateway')
                  )
              ),
              AjustesAplicaveis AS (
                SELECT
                  Id,
                  FisioterapeutaId,
                  TransacaoId,
                  ConsultaId,
                  CAST(CASE
                    WHEN Acumulado <= @ValorBruto THEN ValorPendente
                    WHEN Acumulado - ValorPendente >= @ValorBruto THEN 0
                    ELSE @ValorBruto - (Acumulado - ValorPendente)
                  END AS DECIMAL(10,2)) AS ValorAplicado
                FROM AjustesOrdenados
              )
              INSERT INTO dbo.LoteRepassesGatewayAjustes
                (LoteId, AjusteRepasseId, FisioterapeutaId, TransacaoId, ConsultaId, ValorAplicado, StatusAjuste, AtivoGatewayAjuste)
              SELECT
                @LoteId,
                Id,
                FisioterapeutaId,
                TransacaoId,
                ConsultaId,
                ValorAplicado,
                N'Reservado',
                1
              FROM AjustesAplicaveis
              WHERE ValorAplicado > 0;

              SELECT @ValorAjustes = CAST(ISNULL(SUM(ValorAplicado), 0) AS DECIMAL(10,2))
              FROM dbo.LoteRepassesGatewayAjustes
              WHERE LoteId = @LoteId;

              SET @ValorDisponivel = CAST(@ValorBruto - @ValorAjustes AS DECIMAL(10,2));
              IF @ValorDisponivel <= 0
                SET @ValorTarifaTransferencia = 0;

              ;WITH ItensOrdenados AS (
                SELECT
                  Id,
                  ValorRepasse,
                  CAST(SUM(ValorRepasse) OVER (ORDER BY Id ROWS UNBOUNDED PRECEDING) AS DECIMAL(10,2)) AS Acumulado
                FROM dbo.LoteRepassesGatewayItens
                WHERE LoteId = @LoteId
              ),
              ItensCalculados AS (
                SELECT
                  Id,
                  CAST(CASE
                    WHEN @ValorAjustes <= 0 THEN 0
                    WHEN Acumulado <= @ValorAjustes THEN ValorRepasse
                    WHEN Acumulado - ValorRepasse >= @ValorAjustes THEN 0
                    ELSE @ValorAjustes - (Acumulado - ValorRepasse)
                  END AS DECIMAL(10,2)) AS ValorAjusteAplicado
                FROM ItensOrdenados
              )
              UPDATE i
              SET ValorAjusteAplicado = c.ValorAjusteAplicado,
                  ValorTransferidoItem = CAST(i.ValorRepasse - c.ValorAjusteAplicado AS DECIMAL(10,2)),
                  AtualizadoEm = SYSDATETIME()
              FROM dbo.LoteRepassesGatewayItens i
              JOIN ItensCalculados c ON c.Id = i.Id;

              UPDATE dbo.LotesRepassesGateway
              SET ValorBrutoRepasses = @ValorBruto,
                  ValorAjustesAplicados = @ValorAjustes,
                  MetodoTransferencia = @MetodoTransferencia,
                  ValorTarifaTransferencia = @ValorTarifaTransferencia,
                  TarifaTransferenciaDescricao = CASE
                    WHEN @ValorTarifaTransferencia > 0
                      THEN LEFT(CONCAT(N'Tarifa ', @MetodoTransferencia, N' conforme termos e condições vigentes.'), 120)
                    ELSE NULL
                  END,
                  ValorTransferencia = CAST(CASE
                    WHEN @ValorDisponivel <= 0 THEN 0
                    ELSE @ValorDisponivel - @ValorTarifaTransferencia
                  END AS DECIMAL(10,2)),
                  AtualizadoEm = SYSDATETIME()
              WHERE Id = @LoteId;
            END
          END
        END

        COMMIT;

        IF @LoteId IS NULL AND @SkipFisioId IS NOT NULL
        BEGIN
          SELECT
            CAST(1 AS BIT) AS __Skip,
            @SkipFisioId AS FisioterapeutaId,
            @SkipMetodo AS MetodoTransferencia,
            @SkipValorDisponivel AS ValorDisponivel,
            @SkipTarifa AS ValorTarifaTransferencia,
            @SkipMinimo AS ValorMinimoTransferencia,
            @SkipMotivo AS Motivo;
        END
        ELSE IF @LoteId IS NULL
        BEGIN
          SELECT TOP (0)
            l.*,
            f.Nome AS NomeFisioterapeuta,
            f.CNPJ,
            f.Banco,
            f.Agencia,
            f.Conta,
            f.TipoContaBancaria,
            f.ChavePix,
            f.TipoChavePix
          FROM dbo.LotesRepassesGateway l
          JOIN dbo.Fisioterapeutas f ON f.Id = l.FisioterapeutaId;
        END
        ELSE
        BEGIN
          SELECT TOP (1)
            l.*,
            f.Nome AS NomeFisioterapeuta,
            f.CNPJ,
            f.Banco,
            f.Agencia,
            f.Conta,
            f.TipoContaBancaria,
            f.ChavePix,
            f.TipoChavePix
          FROM dbo.LotesRepassesGateway l
          JOIN dbo.Fisioterapeutas f ON f.Id = l.FisioterapeutaId
          WHERE l.Id = @LoteId;
        END
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH
    `);

    const row = result?.recordset?.[0] ?? null;
    if (row?.__Skip) {
      log('info', 'Repasse gateway aguardando acumulação', {
        fisioterapeutaId: row.FisioterapeutaId,
        metodoTransferencia: row.MetodoTransferencia,
        valorDisponivel: row.ValorDisponivel,
        valorTarifaTransferencia: row.ValorTarifaTransferencia,
        valorMinimoTransferencia: row.ValorMinimoTransferencia,
        motivo: row.Motivo,
      });
      return null;
    }

    return row;
  },

  async marcarTransferenciaSolicitada(lote, transfer, usuario = null) {
    const ctx = safeUser(usuario);
    const transferId = getTransferId(transfer);
    const transferStatus = getTransferStatus(transfer) ?? 'PENDING';
    const receiptUrl = getReceiptUrl(transfer);
    const transferFee = getTransferFee(transfer);
    const statusLote = isDone(transferStatus) ? 'AguardandoConfirmacao' : 'AguardandoConfirmacao';

    const result = await queryWithContext(ctx, (req) => {
      req.input('LoteId', sql.Int, Number(lote.Id));
      req.input('TransferId', sql.NVarChar(80), transferId);
      req.input('TransferStatus', sql.NVarChar(40), text(transferStatus, 40));
      req.input('ReceiptUrl', sql.NVarChar(500), receiptUrl);
      req.input('TransferFee', sql.Decimal(10, 2), transferFee);
      req.input('StatusLote', sql.NVarChar(30), statusLote);
    }, `
      SET NOCOUNT ON;

      UPDATE dbo.LotesRepassesGateway
      SET Status = @StatusLote,
          AtivoGateway = 1,
          GatewayTransferId = COALESCE(@TransferId, GatewayTransferId),
          GatewayTransferStatus = COALESCE(@TransferStatus, GatewayTransferStatus),
          GatewayReceiptUrl = COALESCE(@ReceiptUrl, GatewayReceiptUrl),
          GatewayTransferFee = COALESCE(@TransferFee, GatewayTransferFee),
          GatewayUltimoEvento = N'FISIOHELP_TRANSFER_REQUESTED',
          EnviadoEm = COALESCE(EnviadoEm, SYSDATETIME()),
          ProcessandoEm = NULL,
          GatewayErroMensagem = NULL,
          AtualizadoEm = SYSDATETIME()
      WHERE Id = @LoteId;

      UPDATE dbo.LoteRepassesGatewayItens
      SET StatusItem = N'EnviadoGateway',
          AtivoGatewayItem = 1,
          AtualizadoEm = SYSDATETIME()
      WHERE LoteId = @LoteId
        AND StatusItem = N'Reservado';

      UPDATE dbo.LoteRepassesGatewayAjustes
      SET StatusAjuste = N'EnviadoGateway',
          AtivoGatewayAjuste = 1,
          AtualizadoEm = SYSDATETIME()
      WHERE LoteId = @LoteId
        AND StatusAjuste = N'Reservado';

      UPDATE r
      SET GatewayProvider = N'asaas',
          GatewayTransferId = COALESCE(@TransferId, r.GatewayTransferId),
          GatewayTransferStatus = COALESCE(@TransferStatus, r.GatewayTransferStatus),
          GatewayTransferValor = i.ValorTransferidoItem,
          GatewayTransferReceiptUrl = COALESCE(@ReceiptUrl, r.GatewayTransferReceiptUrl),
          GatewaySolicitadoEm = COALESCE(r.GatewaySolicitadoEm, SYSDATETIME()),
          GatewayUltimoEvento = N'FISIOHELP_TRANSFER_REQUESTED',
          GatewayAtualizadoEm = SYSDATETIME(),
          GatewayErroMensagem = NULL
      FROM dbo.Repasses r
      JOIN dbo.LoteRepassesGatewayItens i ON i.RepasseId = r.Id
      WHERE i.LoteId = @LoteId;

      SELECT TOP (1) *
      FROM dbo.LotesRepassesGateway
      WHERE Id = @LoteId;
    `);

    return result?.recordset?.[0] ?? null;
  },

  async finalizarLoteConfirmado({ loteId, transfer = null, event = 'TRANSFER_DONE' } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    const idLote = toInt(loteId);
    if (!idLote) return null;

    const transferId = getTransferId(transfer);
    const transferStatus = getTransferStatus(transfer) ?? 'DONE';
    const receiptUrl = getReceiptUrl(transfer);
    const transferFee = getTransferFee(transfer);

    const result = await queryWithContext(ctx, (req) => {
      req.input('LoteId', sql.Int, idLote);
      req.input('TransferId', sql.NVarChar(80), transferId);
      req.input('TransferStatus', sql.NVarChar(40), text(transferStatus, 40));
      req.input('ReceiptUrl', sql.NVarChar(500), receiptUrl);
      req.input('TransferFee', sql.Decimal(10, 2), transferFee);
      req.input('Evento', sql.NVarChar(80), text(event, 80) ?? 'TRANSFER_DONE');
      req.input('UsuarioLog', sql.NVarChar(100), text(`${ctx.tipo}:${ctx.id}`, 100) ?? 'Sistema');
    }, `
      SET NOCOUNT ON;
      SET XACT_ABORT ON;

      BEGIN TRY
        BEGIN TRAN;

        DECLARE @Agora DATETIME2(7) = SYSDATETIME();

        UPDATE dbo.LotesRepassesGateway
        SET Status = N'Concluido',
            AtivoGateway = 0,
            GatewayTransferId = COALESCE(@TransferId, GatewayTransferId),
            GatewayTransferStatus = COALESCE(@TransferStatus, GatewayTransferStatus, N'DONE'),
            GatewayReceiptUrl = COALESCE(@ReceiptUrl, GatewayReceiptUrl),
            GatewayTransferFee = COALESCE(@TransferFee, GatewayTransferFee),
            GatewayUltimoEvento = @Evento,
            ConfirmadoEm = COALESCE(ConfirmadoEm, @Agora),
            ProcessandoEm = NULL,
            GatewayErroMensagem = NULL,
            AtualizadoEm = @Agora
        WHERE Id = @LoteId
          AND Status IN (N'Processando', N'EnviadoGateway', N'AguardandoConfirmacao', N'Concluido');

        UPDATE r
        SET Status = N'Pago',
            DataPagamento = COALESCE(r.DataPagamento, @Agora),
            ValorLiquido = i.ValorTransferidoItem,
            GatewayProvider = N'asaas',
            GatewayTransferId = COALESCE(@TransferId, r.GatewayTransferId),
            GatewayTransferStatus = COALESCE(@TransferStatus, r.GatewayTransferStatus, N'DONE'),
            GatewayTransferValor = i.ValorTransferidoItem,
            GatewayTransferReceiptUrl = COALESCE(@ReceiptUrl, r.GatewayTransferReceiptUrl),
            GatewayConfirmadoEm = COALESCE(r.GatewayConfirmadoEm, @Agora),
            GatewayUltimoEvento = @Evento,
            GatewayAtualizadoEm = @Agora,
            GatewayErroMensagem = NULL
        FROM dbo.Repasses r WITH (UPDLOCK, HOLDLOCK)
        JOIN dbo.LoteRepassesGatewayItens i ON i.RepasseId = r.Id
        WHERE i.LoteId = @LoteId
          AND i.StatusItem IN (N'Reservado', N'EnviadoGateway', N'Pago', N'LiquidadoPorAjuste');

        UPDATE dbo.LoteRepassesGatewayItens
        SET StatusItem = CASE WHEN ValorTransferidoItem > 0 THEN N'Pago' ELSE N'LiquidadoPorAjuste' END,
            AtivoGatewayItem = 0,
            AtualizadoEm = @Agora
        WHERE LoteId = @LoteId
          AND StatusItem IN (N'Reservado', N'EnviadoGateway', N'Falha');

        UPDATE ar
        SET ValorPendente = CAST(CASE
                WHEN ar.ValorPendente <= la.ValorAplicado THEN 0
                ELSE ar.ValorPendente - la.ValorAplicado
              END AS DECIMAL(10,2)),
            Status = CASE
                WHEN ar.ValorPendente <= la.ValorAplicado THEN N'Aplicado'
                ELSE N'Pendente'
              END,
            AplicadoEm = CASE
                WHEN ar.ValorPendente <= la.ValorAplicado THEN COALESCE(ar.AplicadoEm, @Agora)
                ELSE ar.AplicadoEm
              END
        FROM dbo.AjustesRepasses ar WITH (UPDLOCK, HOLDLOCK)
        JOIN dbo.LoteRepassesGatewayAjustes la ON la.AjusteRepasseId = ar.Id
        WHERE la.LoteId = @LoteId
          AND la.StatusAjuste IN (N'Reservado', N'EnviadoGateway', N'Aplicado');

        UPDATE dbo.LoteRepassesGatewayAjustes
        SET StatusAjuste = N'Aplicado',
            AtivoGatewayAjuste = 0,
            AtualizadoEm = @Agora
        WHERE LoteId = @LoteId
          AND StatusAjuste IN (N'Reservado', N'EnviadoGateway', N'Falha');

        INSERT INTO dbo.LogsFinanceiros
          (TransacaoId, RepasseId, Usuario, Acao, DataAcao, Observacao)
        SELECT
          i.TransacaoId,
          i.RepasseId,
          @UsuarioLog,
          N'Repasse',
          @Agora,
          LEFT(CONCAT(
            N'Pago via Asaas lote ', CONVERT(NVARCHAR(20), @LoteId),
            N' | Valor=', CONVERT(NVARCHAR(30), i.ValorTransferidoItem),
            N' | Ajuste=', CONVERT(NVARCHAR(30), i.ValorAjusteAplicado),
            N' | TarifaLote=', CONVERT(NVARCHAR(30), l.ValorTarifaTransferencia)
          ), 255)
        FROM dbo.LoteRepassesGatewayItens i
        JOIN dbo.LotesRepassesGateway l ON l.Id = i.LoteId
        WHERE i.LoteId = @LoteId
          AND i.ValorTransferidoItem > 0
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.LogsFinanceiros lf
            WHERE lf.RepasseId = i.RepasseId
              AND lf.Acao = N'Repasse'
              AND lf.Observacao LIKE CONCAT(N'Pago via Asaas lote ', CONVERT(NVARCHAR(20), @LoteId), N'%')
          );

        COMMIT;

        SELECT TOP (1) *
        FROM dbo.LotesRepassesGateway
        WHERE Id = @LoteId;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH
    `);

    const row = result?.recordset?.[0] ?? null;
    if (row?.Id) {
      void notificacoesDispatch.repasseConcluido({ loteId: row.Id }).catch((err) => {
        log('warn', 'Falha ao enfileirar notificação de repasse concluído', {
          loteId: row.Id,
          erro: err?.message,
        });
      });
    }

    return row;
  },

  async marcarFalha(lote, erro, { maxAttempts = 8 } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    const tentativas = Number(lote?.Tentativas ?? 1);
    const status = tentativas >= maxAttempts ? 'FalhaDefinitiva' : 'FalhaTemporaria';
    const delayMinutes = Math.min(240, Math.max(1, 2 ** Math.min(tentativas, 7)));
    const idLote = toInt(lote?.Id);
    if (!idLote) return null;

    const result = await queryWithContext(ctx, (req) => {
      req.input('LoteId', sql.Int, idLote);
      req.input('Status', sql.NVarChar(30), status);
      req.input('DelayMinutes', sql.Int, delayMinutes);
      req.input('Erro', sql.NVarChar(500), text(erro?.message ?? erro ?? 'Falha ao processar repasse gateway.', 500));
    }, `
      SET NOCOUNT ON;

      UPDATE dbo.LotesRepassesGateway
      SET Status = @Status,
          AtivoGateway = 0,
          ProcessandoEm = NULL,
          ProximaTentativaEm = CASE
            WHEN @Status = N'FalhaTemporaria' THEN DATEADD(MINUTE, @DelayMinutes, SYSDATETIME())
            ELSE NULL
          END,
          GatewayErroMensagem = @Erro,
          GatewayUltimoEvento = N'FISIOHELP_TRANSFER_WORKER_ERROR',
          AtualizadoEm = SYSDATETIME()
      WHERE Id = @LoteId;

      UPDATE dbo.LoteRepassesGatewayItens
      SET StatusItem = N'Falha',
          AtivoGatewayItem = 0,
          AtualizadoEm = SYSDATETIME()
      WHERE LoteId = @LoteId
        AND StatusItem IN (N'Reservado', N'EnviadoGateway');

      UPDATE dbo.LoteRepassesGatewayAjustes
      SET StatusAjuste = N'Falha',
          AtivoGatewayAjuste = 0,
          AtualizadoEm = SYSDATETIME()
      WHERE LoteId = @LoteId
        AND StatusAjuste IN (N'Reservado', N'EnviadoGateway');

      UPDATE r
      SET GatewayErroMensagem = @Erro,
          GatewayUltimoEvento = N'FISIOHELP_TRANSFER_WORKER_ERROR',
          GatewayAtualizadoEm = SYSDATETIME()
      FROM dbo.Repasses r
      JOIN dbo.LoteRepassesGatewayItens i ON i.RepasseId = r.Id
      WHERE i.LoteId = @LoteId;

      SELECT TOP (1) *
      FROM dbo.LotesRepassesGateway
      WHERE Id = @LoteId;
    `);

    return result?.recordset?.[0] ?? null;
  },

  async processarLote(lote, usuario = null) {
    const ctx = safeUser(usuario);
    if (!lote?.Id) return null;

    const valorTransferencia = toMoney(lote.ValorTransferencia);
    if (valorTransferencia === null) {
      throw new Error('Valor de transferência inválido para lote de repasse.');
    }

    if (valorTransferencia === 0) {
      return this.finalizarLoteConfirmado({
        loteId: lote.Id,
        transfer: {
          id: lote.GatewayTransferId,
          status: 'DONE',
          transactionReceiptUrl: lote.GatewayReceiptUrl,
        },
        event: 'FISIOHELP_TRANSFER_LIQUIDATED_BY_ADJUSTMENT',
      }, ctx);
    }

    const payload = buildAsaasTransferPayload(lote);
    const transfer = await asaasClient.criarTransferencia(payload);
    if (!getTransferId(transfer)) {
      throw new Error('Asaas não retornou o identificador da transferência.');
    }

    const solicitada = await this.marcarTransferenciaSolicitada(lote, transfer, ctx);
    const transferStatus = getTransferStatus(transfer);

    if (isDone(transferStatus)) {
      return this.finalizarLoteConfirmado({
        loteId: lote.Id,
        transfer,
        event: 'TRANSFER_DONE',
      }, ctx);
    }

    if (isFalha(transferStatus)) {
      throw new Error(`Transferência Asaas recusada ou cancelada: ${transferStatus}`);
    }

    return solicitada;
  },

  async reconciliarAguardando({ limit = 5, minAgeMinutes = 5 } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    const result = await queryWithContext(ctx, (req) => {
      req.input('Limit', sql.Int, Math.max(1, Math.min(Number(limit) || 5, 20)));
      req.input('MinAgeMinutes', sql.Int, Math.max(1, Number(minAgeMinutes) || 5));
    }, `
      SELECT TOP (@Limit) *
      FROM dbo.LotesRepassesGateway WITH (READCOMMITTEDLOCK)
      WHERE Status IN (N'EnviadoGateway', N'AguardandoConfirmacao')
        AND GatewayTransferId IS NOT NULL
        AND COALESCE(EnviadoEm, AtualizadoEm, CriadoEm) <= DATEADD(MINUTE, -@MinAgeMinutes, SYSDATETIME())
      ORDER BY COALESCE(EnviadoEm, AtualizadoEm, CriadoEm), Id;
    `);

    const rows = result?.recordset ?? [];
    for (const row of rows) {
      try {
        const transfer = await asaasClient.obterTransferencia(row.GatewayTransferId);
        const status = getTransferStatus(transfer);

        if (isDone(status)) {
          await this.finalizarLoteConfirmado({
            loteId: row.Id,
            transfer,
            event: 'FISIOHELP_TRANSFER_RECONCILED',
          }, ctx);
        } else if (isFalha(status)) {
          await this.marcarFalha(
            row,
            new Error(`Transferência Asaas em status final de falha: ${status}`),
            { maxAttempts: 8 },
            ctx
          );
        } else {
          await this.atualizarStatusGateway({
            loteId: row.Id,
            transfer,
            event: 'FISIOHELP_TRANSFER_RECONCILED_PENDING',
          }, ctx);
        }
      } catch (err) {
        log('warn', 'Falha ao reconciliar repasse Asaas', {
          loteId: row.Id,
          transferId: row.GatewayTransferId,
          erro: err?.message,
        });
      }
    }
  },

  async atualizarStatusGateway({ loteId, transfer, event = null } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    const idLote = toInt(loteId);
    if (!idLote) return null;

    const transferId = getTransferId(transfer);
    const transferStatus = getTransferStatus(transfer);
    const receiptUrl = getReceiptUrl(transfer);
    const transferFee = getTransferFee(transfer);

    const result = await queryWithContext(ctx, (req) => {
      req.input('LoteId', sql.Int, idLote);
      req.input('TransferId', sql.NVarChar(80), transferId);
      req.input('TransferStatus', sql.NVarChar(40), text(transferStatus, 40));
      req.input('ReceiptUrl', sql.NVarChar(500), receiptUrl);
      req.input('TransferFee', sql.Decimal(10, 2), transferFee);
      req.input('Evento', sql.NVarChar(80), text(event, 80));
    }, `
      UPDATE dbo.LotesRepassesGateway
      SET GatewayTransferId = COALESCE(@TransferId, GatewayTransferId),
          GatewayTransferStatus = COALESCE(@TransferStatus, GatewayTransferStatus),
          GatewayReceiptUrl = COALESCE(@ReceiptUrl, GatewayReceiptUrl),
          GatewayTransferFee = COALESCE(@TransferFee, GatewayTransferFee),
          GatewayUltimoEvento = COALESCE(@Evento, GatewayUltimoEvento),
          AtualizadoEm = SYSDATETIME()
      WHERE Id = @LoteId;

      UPDATE r
      SET GatewayTransferId = COALESCE(@TransferId, r.GatewayTransferId),
          GatewayTransferStatus = COALESCE(@TransferStatus, r.GatewayTransferStatus),
          GatewayTransferReceiptUrl = COALESCE(@ReceiptUrl, r.GatewayTransferReceiptUrl),
          GatewayUltimoEvento = COALESCE(@Evento, r.GatewayUltimoEvento),
          GatewayAtualizadoEm = SYSDATETIME()
      FROM dbo.Repasses r
      JOIN dbo.LoteRepassesGatewayItens i ON i.RepasseId = r.Id
      WHERE i.LoteId = @LoteId;

      SELECT TOP (1) *
      FROM dbo.LotesRepassesGateway
      WHERE Id = @LoteId;
    `);

    return result?.recordset?.[0] ?? null;
  },

  async processarWebhookTransferenciaAsaas({ event, transfer = null, body = null } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    const payloadTransfer = transfer ?? body?.transfer ?? body?.data?.transfer ?? body?.object ?? {};
    const transferId = getTransferId(payloadTransfer);
    const statusFromEvent = eventoTransferenciaFinal(event);
    const status = getTransferStatus(payloadTransfer) ?? statusFromEvent;

    if (!transferId) {
      log('warn', 'Webhook Asaas de transferência sem transferId', { event });
      return null;
    }

    const loteResult = await queryWithContext(ctx, (req) => {
      req.input('TransferId', sql.NVarChar(80), transferId);
    }, `
      SELECT TOP (1) *
      FROM dbo.LotesRepassesGateway WITH (READCOMMITTEDLOCK)
      WHERE GatewayTransferId = @TransferId
      ORDER BY Id DESC;
    `);

    const lote = loteResult?.recordset?.[0] ?? null;
    if (!lote) {
      log('warn', 'Webhook Asaas de transferência sem lote mapeado', { event, transferId });
      return null;
    }

    if (statusFromEvent === 'DONE' || isDone(status)) {
      return this.finalizarLoteConfirmado({
        loteId: lote.Id,
        transfer: payloadTransfer,
        event,
      }, ctx);
    }

    if (statusFromEvent === 'FAILED' || isFalha(status)) {
      return this.marcarFalha(
        lote,
        new Error(`Transferência Asaas falhou: ${event}`),
        { maxAttempts: Number(lote.Tentativas ?? 1) },
        ctx
      );
    }

    return this.atualizarStatusGateway({
      loteId: lote.Id,
      transfer: payloadTransfer,
      event,
    }, ctx);
  },

  async validarSolicitacaoSaqueAsaas({ transfer = null, body = null } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    const payloadTransfer = transfer ?? body?.transfer ?? body?.data?.transfer ?? body?.object ?? {};
    const transferId = getTransferId(payloadTransfer);
    const externalReference = getTransferExternalReference(payloadTransfer) ?? text(body?.externalReference, 80);
    const loteId = getLoteIdFromExternalReference(externalReference);
    const transferValue = toMoney(payloadTransfer?.value);

    if (!transferId && !loteId) {
      log('warn', 'Validação de saque Asaas sem identificador mapeável', {
        transferId: transferId ?? null,
        externalReference: externalReference ?? null,
      });
      return {
        status: 'REFUSED',
        refuseReason: 'Transferência sem referência reconhecida pelo FisioHelp.',
      };
    }

    const result = await queryWithContext(ctx, (req) => {
      req.input('TransferId', sql.NVarChar(80), transferId);
      req.input('LoteId', sql.Int, loteId);
    }, `
      SELECT TOP (1) *
      FROM dbo.LotesRepassesGateway WITH (UPDLOCK, HOLDLOCK)
      WHERE
        (@TransferId IS NOT NULL AND GatewayTransferId = @TransferId)
        OR (@LoteId IS NOT NULL AND Id = @LoteId)
      ORDER BY
        CASE WHEN @TransferId IS NOT NULL AND GatewayTransferId = @TransferId THEN 0 ELSE 1 END,
        Id DESC;
    `);

    const lote = result?.recordset?.[0] ?? null;
    if (!lote) {
      log('warn', 'Validação de saque Asaas recusada: lote não encontrado', {
        transferId: transferId ?? null,
        externalReference: externalReference ?? null,
        loteId: loteId ?? null,
      });
      return {
        status: 'REFUSED',
        refuseReason: 'Lote de repasse não encontrado no FisioHelp.',
      };
    }

    if (!STATUS_LOTE_ATIVO.includes(String(lote.Status ?? '').trim())) {
      log('warn', 'Validação de saque Asaas recusada: lote inativo', {
        loteId: lote.Id,
        status: lote.Status,
        transferId: transferId ?? null,
      });
      return {
        status: 'REFUSED',
        refuseReason: 'Lote de repasse não está ativo para transferência.',
      };
    }

    if (transferId && lote.GatewayTransferId && String(lote.GatewayTransferId) !== String(transferId)) {
      log('warn', 'Validação de saque Asaas recusada: transferId divergente', {
        loteId: lote.Id,
        transferId,
        esperado: lote.GatewayTransferId,
      });
      return {
        status: 'REFUSED',
        refuseReason: 'Identificador da transferência diverge do lote de repasse.',
      };
    }

    const valorLote = toMoney(lote.ValorTransferencia);
    if (transferValue !== null && valorLote !== null && Math.abs(transferValue - valorLote) > 0.01) {
      log('warn', 'Validação de saque Asaas recusada: valor divergente', {
        loteId: lote.Id,
        transferValue,
        valorLote,
      });
      return {
        status: 'REFUSED',
        refuseReason: 'Valor da transferência diverge do lote de repasse.',
      };
    }

    await this.atualizarStatusGateway({
      loteId: lote.Id,
      transfer: payloadTransfer,
      event: 'FISIOHELP_TRANSFER_AUTH_APPROVED',
    }, ctx);

    log('info', 'Validação de saque Asaas aprovada', {
      loteId: lote.Id,
      transferId: transferId ?? null,
      externalReference: externalReference ?? null,
    });

    return { status: 'APPROVED' };
  },
};

export default repassesGatewayService;
