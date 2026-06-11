import { sql } from '../config/dbConfig.js';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { queryWithContext } from './_queryWithContext.js';
import pagamentosGatewayService from './pagamentosGatewayService.js';
import { asaasClient } from './asaasClient.js';

const STATUS_ABERTOS = [
  'Pendente',
  'Processando',
  'Solicitado',
  'FalhaTemporaria',
  'Parcial',
];

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
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function text(value, max = 500) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeOrigem(value) {
  const raw = text(value, 30) ?? 'Admin';
  if (['Arrependimento', 'Disputa', 'Pacote', 'Admin', 'Reconciliacao'].includes(raw)) return raw;
  return 'Admin';
}

function statusFromRefundEvent(event, { pacote = false } = {}) {
  switch (String(event ?? '').trim().toUpperCase()) {
    case 'PAYMENT_REFUNDED':
      return 'Confirmado';
    case 'PAYMENT_PARTIALLY_REFUNDED':
      return pacote ? 'Confirmado' : 'Parcial';
    case 'PAYMENT_REFUND_DENIED':
      return 'Negado';
    case 'PAYMENT_REFUND_IN_PROGRESS':
      return 'Solicitado';
    default:
      return null;
  }
}

function getPaymentId(payment) {
  return text(payment?.id ?? payment?.paymentId ?? payment?.payment_id, 100);
}

function getInstallmentId(payment) {
  const installment = payment?.installment;
  return text(
    (installment && typeof installment === 'object' ? installment.id : installment) ??
      payment?.installmentId ??
      payment?.installment_id,
    100
  );
}

function getLatestRefund(refundsResponse) {
  const rows = Array.isArray(refundsResponse?.data)
    ? refundsResponse.data
    : Array.isArray(refundsResponse?.refunds)
      ? refundsResponse.refunds
      : [];

  if (rows.length === 0) return null;

  return [...rows].sort((a, b) => {
    const da = Date.parse(a?.dateCreated ?? a?.createdAt ?? '') || 0;
    const db = Date.parse(b?.dateCreated ?? b?.createdAt ?? '') || 0;
    return db - da;
  })[0] ?? null;
}

function mapRefundStatusToFila(status) {
  const normalized = String(status ?? '').trim().toUpperCase();
  if (['DONE', 'REFUNDED', 'CONFIRMED', 'RECEIVED'].includes(normalized)) return 'Confirmado';
  if (['PARTIAL', 'PARTIALLY_REFUNDED'].includes(normalized)) return 'Parcial';
  if (['DENIED', 'REFUSED', 'CANCELLED', 'CANCELED'].includes(normalized)) return 'Negado';
  if ([
    'PENDING',
    'IN_PROGRESS',
    'PROCESSING',
    'REQUESTED',
    'AWAITING_REQUEST',
    'AWAITING_CUSTOMER_EXTERNAL_AUTHORIZATION',
    'AWAITING_EXTERNAL_AUTHORIZATION',
  ].includes(normalized)) return 'Solicitado';
  return null;
}

function buildRefundInfoFromAsaas(refund, fallbackValue = null, fallbackDescription = null) {
  return {
    refundId: text(refund?.id, 100),
    status: text(refund?.status, 60),
    value: toMoney(refund?.value ?? fallbackValue),
    description: text(refund?.description ?? fallbackDescription, 500),
    receiptUrl: text(refund?.transactionReceiptUrl, 500),
  };
}

function denialReasonFromAdditionalInfo(additionalInfo = null) {
  return text(
    additionalInfo?.denialReason ??
      additionalInfo?.refusalReason ??
      additionalInfo?.refundDeniedReason ??
      additionalInfo?.reason,
    500
  );
}

function getPixRefundPayload(body = null) {
  return body?.pixRefund ?? body?.data?.pixRefund ?? body?.refund ?? body?.data?.refund ?? null;
}

function getPixRefundId(pixRefund = null) {
  return text(pixRefund?.id ?? pixRefund?.refundId ?? pixRefund?.refund_id, 100);
}

function getPixRefundStatus(pixRefund = null) {
  return text(pixRefund?.status ?? pixRefund?.refundStatus ?? pixRefund?.refund_status, 60);
}

function getPixRefundPaymentId(pixRefund = null, body = null) {
  const payment = pixRefund?.payment;
  return text(
    (payment && typeof payment === 'object' ? payment.id : payment) ??
      pixRefund?.paymentId ??
      pixRefund?.payment_id ??
      body?.paymentId ??
      body?.payment_id,
    100
  );
}

function getPixRefundValue(pixRefund = null, body = null) {
  return toMoney(pixRefund?.value ?? pixRefund?.refundValue ?? pixRefund?.refund_value ?? body?.value);
}

function getPixRefundDescription(pixRefund = null, body = null) {
  return text(pixRefund?.description ?? body?.description, 500);
}

function isPixRefundAuthorization(body = null) {
  const type = String(body?.type ?? body?.event ?? body?.object ?? body?.data?.type ?? '').trim().toUpperCase();
  return type === 'PIX_REFUND' || Boolean(getPixRefundPayload(body));
}

const reembolsosGatewayFilaService = {
  async filaDisponivel(usuario = null) {
    const ctx = safeUser(usuario);
    const result = await queryWithContext(ctx, () => {}, `
      SELECT CASE
        WHEN OBJECT_ID(N'dbo.FilaReembolsosGateway', N'U') IS NULL THEN 0
        ELSE 1
      END AS Disponivel;
    `);

    return Number(result?.recordset?.[0]?.Disponivel ?? 0) === 1;
  },

  async enfileirarReembolso({
    transacaoId,
    consultaId = null,
    pacoteId = null,
    disputaId = null,
    origem = 'Admin',
    provider = 'asaas',
    gatewayPaymentId = null,
    gatewayInstallmentId = null,
    valor = null,
    motivo = null,
  } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    const idTransacao = toInt(transacaoId);
    const idPacote = toInt(pacoteId);
    if (!idTransacao && !idPacote) {
      const err = new Error('TransacaoId ou PacoteId inválido para fila de reembolso.');
      err.statusCode = 400;
      throw err;
    }

    const result = await queryWithContext(ctx, (req) => {
      req.input('TransacaoId', sql.Int, idTransacao);
      req.input('ConsultaId', sql.Int, toInt(consultaId));
      req.input('PacoteId', sql.Int, idPacote);
      req.input('DisputaId', sql.Int, toInt(disputaId));
      req.input('Origem', sql.NVarChar(30), normalizeOrigem(origem));
      req.input('Provider', sql.NVarChar(30), text(provider, 30) ?? 'asaas');
      req.input('GatewayPaymentId', sql.NVarChar(100), text(gatewayPaymentId, 100));
      req.input('GatewayInstallmentId', sql.NVarChar(100), text(gatewayInstallmentId, 100));
      req.input('Valor', sql.Decimal(10, 2), toMoney(valor));
      req.input('Motivo', sql.NVarChar(500), text(motivo, 500));
      req.input('UsuarioRegistro', sql.NVarChar(200), text(`${ctx.tipo}:${ctx.id}`, 200));
    }, `
      SET NOCOUNT ON;
      SET XACT_ABORT ON;

      BEGIN TRY
        BEGIN TRAN;

        DECLARE
          @FilaId INT = NULL,
          @ConsultaEfetiva INT = @ConsultaId,
          @GatewayPaymentEfetivo NVARCHAR(100) = @GatewayPaymentId,
          @GatewayInstallmentEfetivo NVARCHAR(100) = @GatewayInstallmentId,
          @ValorEfetivo DECIMAL(10,2) = @Valor;

        IF @TransacaoId IS NOT NULL
        BEGIN
          SELECT
            @ConsultaEfetiva = COALESCE(@ConsultaEfetiva, t.ConsultaId),
            @GatewayPaymentEfetivo = COALESCE(@GatewayPaymentEfetivo, t.GatewayPaymentId),
            @ValorEfetivo = COALESCE(@ValorEfetivo, t.ValorTotal)
          FROM dbo.Transacoes t WITH (UPDLOCK, HOLDLOCK)
          WHERE t.Id = @TransacaoId;

          IF @ConsultaEfetiva IS NULL
            THROW 51300, 'Transação não encontrada para enfileirar reembolso.', 1;

          SELECT TOP (1) @FilaId = Id
          FROM dbo.FilaReembolsosGateway WITH (UPDLOCK, HOLDLOCK)
          WHERE TransacaoId = @TransacaoId
            AND Status IN (N'Pendente', N'Processando', N'Solicitado', N'FalhaTemporaria', N'Parcial')
          ORDER BY Id DESC;
        END
        ELSE
        BEGIN
          SELECT
            @GatewayPaymentEfetivo = COALESCE(@GatewayPaymentEfetivo, p.GatewayPaymentId),
            @GatewayInstallmentEfetivo = COALESCE(@GatewayInstallmentEfetivo, p.GatewayInstallmentId),
            @ValorEfetivo = COALESCE(@ValorEfetivo, p.ValorPago, p.ValorTotal)
          FROM dbo.Pacotes p WITH (UPDLOCK, HOLDLOCK)
          WHERE p.Id = @PacoteId;

          IF @ValorEfetivo IS NULL
            THROW 51301, 'Pacote não encontrado para enfileirar reembolso.', 1;

          SELECT TOP (1) @FilaId = Id
          FROM dbo.FilaReembolsosGateway WITH (UPDLOCK, HOLDLOCK)
          WHERE PacoteId = @PacoteId
            AND Status IN (N'Pendente', N'Processando', N'Solicitado', N'FalhaTemporaria', N'Parcial')
          ORDER BY Id DESC;
        END

        IF @FilaId IS NULL
        BEGIN
          INSERT INTO dbo.FilaReembolsosGateway
            (TransacaoId, ConsultaId, PacoteId, DisputaId, Origem, Provider,
             GatewayPaymentId, GatewayInstallmentId, Valor, Motivo, Status, ProximaTentativaEm, UsuarioRegistro)
          VALUES
            (@TransacaoId, @ConsultaEfetiva, @PacoteId, @DisputaId, @Origem, @Provider,
             @GatewayPaymentEfetivo, @GatewayInstallmentEfetivo, @ValorEfetivo, @Motivo, N'Pendente', SYSDATETIME(), @UsuarioRegistro);

          SET @FilaId = CONVERT(INT, SCOPE_IDENTITY());
        END
        ELSE
        BEGIN
          UPDATE dbo.FilaReembolsosGateway
          SET ConsultaId = COALESCE(ConsultaId, @ConsultaEfetiva),
              PacoteId = COALESCE(PacoteId, @PacoteId),
              DisputaId = COALESCE(DisputaId, @DisputaId),
              GatewayPaymentId = COALESCE(GatewayPaymentId, @GatewayPaymentEfetivo),
              GatewayInstallmentId = COALESCE(GatewayInstallmentId, @GatewayInstallmentEfetivo),
              Valor = COALESCE(Valor, @ValorEfetivo),
              Motivo = COALESCE(@Motivo, Motivo),
              ProximaTentativaEm = CASE
                WHEN Status IN (N'Pendente', N'FalhaTemporaria') THEN COALESCE(ProximaTentativaEm, SYSDATETIME())
                ELSE ProximaTentativaEm
              END,
              AtualizadoEm = SYSDATETIME()
          WHERE Id = @FilaId;
        END

        IF @TransacaoId IS NOT NULL
        BEGIN
          UPDATE dbo.Transacoes
          SET Status = CASE
                WHEN LTRIM(RTRIM(ISNULL(Status, N''))) = N'Reembolsado'
                 AND LTRIM(RTRIM(ISNULL(GatewayRefundStatus, N''))) <> N'DONE'
                  THEN N'Pago'
                ELSE Status
              END,
              GatewayProvider = COALESCE(GatewayProvider, @Provider),
              GatewayPaymentId = COALESCE(GatewayPaymentId, @GatewayPaymentEfetivo),
              GatewayRefundStatus = CASE
                WHEN LTRIM(RTRIM(ISNULL(GatewayRefundStatus, N''))) = N'DONE' THEN GatewayRefundStatus
                ELSE N'QUEUED'
              END,
              GatewayRefundValor = COALESCE(GatewayRefundValor, @ValorEfetivo),
              GatewayRefundDescricao = COALESCE(@Motivo, GatewayRefundDescricao),
              GatewayUltimoEvento = N'FISIOHELP_REFUND_QUEUED',
              GatewayAtualizadoEm = SYSDATETIME(),
              GatewayErroMensagem = NULL
          WHERE Id = @TransacaoId;
        END
        ELSE
        BEGIN
          UPDATE dbo.Pacotes
          SET Gateway = COALESCE(Gateway, @Provider),
              GatewayPaymentId = COALESCE(GatewayPaymentId, @GatewayPaymentEfetivo),
              GatewayInstallmentId = COALESCE(GatewayInstallmentId, @GatewayInstallmentEfetivo),
              GatewayStatus = N'ReembolsoPendente',
              GatewayRefundStatus = CASE
                WHEN LTRIM(RTRIM(ISNULL(GatewayRefundStatus, N''))) IN (N'DONE', N'PARTIAL') THEN GatewayRefundStatus
                ELSE N'QUEUED'
              END,
              GatewayRefundValor = COALESCE(GatewayRefundValor, @ValorEfetivo),
              GatewayRefundDescricao = COALESCE(@Motivo, GatewayRefundDescricao),
              GatewayUltimoEvento = N'FISIOHELP_PACKAGE_REFUND_QUEUED',
              GatewayAtualizadoEm = SYSDATETIME(),
              GatewayErroMensagem = NULL
          WHERE Id = @PacoteId;
        END

        COMMIT;

        SELECT TOP (1) *
        FROM dbo.FilaReembolsosGateway
        WHERE Id = @FilaId;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH
    `);

    return result?.recordset?.[0] ?? null;
  },

  async recuperarProcessandoTravado({ staleMinutes = 10 } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    const minutes = Math.max(1, Number(staleMinutes) || 10);

    const result = await queryWithContext(ctx, (req) => {
      req.input('StaleMinutes', sql.Int, minutes);
    }, `
      UPDATE dbo.FilaReembolsosGateway
      SET Status = N'FalhaTemporaria',
          ProcessandoEm = NULL,
          ProximaTentativaEm = SYSDATETIME(),
          UltimoErro = N'Worker interrompido ou processamento excedeu o tempo limite.',
          AtualizadoEm = SYSDATETIME()
      WHERE Status = N'Processando'
        AND ProcessandoEm < DATEADD(MINUTE, -@StaleMinutes, SYSDATETIME());

      SELECT @@ROWCOUNT AS Recuperados;
    `);

    return Number(result?.recordset?.[0]?.Recuperados ?? 0);
  },

  async claimProximo(usuario = null) {
    const ctx = safeUser(usuario);

    const result = await queryWithContext(ctx, () => {}, `
      ;WITH Proximo AS (
        SELECT TOP (1) *
        FROM dbo.FilaReembolsosGateway WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE Status IN (N'Pendente', N'FalhaTemporaria')
          AND (ProximaTentativaEm IS NULL OR ProximaTentativaEm <= SYSDATETIME())
        ORDER BY
          COALESCE(ProximaTentativaEm, CriadoEm),
          Id
      )
      UPDATE Proximo
      SET Status = N'Processando',
          ProcessandoEm = SYSDATETIME(),
          Tentativas = CASE WHEN Tentativas < 255 THEN Tentativas + 1 ELSE Tentativas END,
          UltimoErro = NULL,
          AtualizadoEm = SYSDATETIME()
      OUTPUT INSERTED.*;
    `);

    return result?.recordset?.[0] ?? null;
  },

  async marcarSolicitado(item, resultado, usuario = null) {
    const ctx = safeUser(usuario);
    const statusGateway = text(resultado?.gatewayRefundStatus, 60);
    const statusFila = resultado?.reembolsoConfirmado
      ? 'Confirmado'
      : String(statusGateway ?? '').toUpperCase() === 'PARTIAL' && !toInt(item?.PacoteId)
        ? 'Parcial'
        : 'Solicitado';

    const result = await queryWithContext(ctx, (req) => {
      req.input('FilaId', sql.Int, Number(item.Id));
      req.input('Status', sql.NVarChar(30), statusFila);
      req.input('PaymentId', sql.NVarChar(100), text(resultado?.paymentId ?? item.GatewayPaymentId, 100));
      req.input('InstallmentId', sql.NVarChar(100), text(resultado?.installmentId ?? item.GatewayInstallmentId, 100));
      req.input('RefundStatus', sql.NVarChar(60), statusGateway);
      req.input('RefundValor', sql.Decimal(10, 2), toMoney(resultado?.gatewayRefundValor ?? item.Valor));
    }, `
      UPDATE dbo.FilaReembolsosGateway
      SET Status = @Status,
          GatewayPaymentId = COALESCE(@PaymentId, GatewayPaymentId),
          GatewayInstallmentId = COALESCE(@InstallmentId, GatewayInstallmentId),
          GatewayRefundStatus = COALESCE(@RefundStatus, GatewayRefundStatus),
          Valor = COALESCE(@RefundValor, Valor),
          ProcessandoEm = NULL,
          SolicitadoEm = COALESCE(SolicitadoEm, SYSDATETIME()),
          ConfirmadoEm = CASE WHEN @Status = N'Confirmado' THEN COALESCE(ConfirmadoEm, SYSDATETIME()) ELSE ConfirmadoEm END,
          UltimoErro = NULL,
          AtualizadoEm = SYSDATETIME()
      WHERE Id = @FilaId;

      SELECT TOP (1) *
      FROM dbo.FilaReembolsosGateway
      WHERE Id = @FilaId;
    `);

    return result?.recordset?.[0] ?? null;
  },

  async marcarErro(item, erro, { maxAttempts = 8 } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    const tentativas = Number(item?.Tentativas ?? 1);
    const status = tentativas >= maxAttempts ? 'FalhaDefinitiva' : 'FalhaTemporaria';
    const delayMinutes = Math.min(120, Math.max(1, 2 ** Math.min(tentativas, 6)));

    const result = await queryWithContext(ctx, (req) => {
      req.input('FilaId', sql.Int, Number(item.Id));
      req.input('PacoteId', sql.Int, toInt(item?.PacoteId));
      req.input('Status', sql.NVarChar(30), status);
      req.input('DelayMinutes', sql.Int, delayMinutes);
      req.input('Erro', sql.NVarChar(500), text(erro?.message ?? erro ?? 'Falha ao solicitar reembolso.', 500));
    }, `
      UPDATE dbo.FilaReembolsosGateway
      SET Status = @Status,
          ProcessandoEm = NULL,
          ProximaTentativaEm = CASE
            WHEN @Status = N'FalhaTemporaria' THEN DATEADD(MINUTE, @DelayMinutes, SYSDATETIME())
            ELSE NULL
          END,
          UltimoErro = @Erro,
          AtualizadoEm = SYSDATETIME()
      WHERE Id = @FilaId;

      IF @PacoteId IS NOT NULL
      BEGIN
        UPDATE dbo.Pacotes
        SET GatewayStatus = CASE
              WHEN @Status = N'FalhaDefinitiva' THEN N'ReembolsoFalhou'
              ELSE GatewayStatus
            END,
            GatewayUltimoEvento = N'FISIOHELP_PACKAGE_REFUND_WORKER_ERROR',
            GatewayErroMensagem = @Erro,
            GatewayAtualizadoEm = SYSDATETIME()
        WHERE Id = @PacoteId;
      END

      SELECT TOP (1) *
      FROM dbo.FilaReembolsosGateway
      WHERE Id = @FilaId;
    `);

    return result?.recordset?.[0] ?? null;
  },

  async processarItem(item, usuario = null) {
    const ctx = safeUser(usuario);
    const idPacote = toInt(item?.PacoteId);
    const idTransacao = toInt(item?.TransacaoId);
    const resultado = idPacote && !idTransacao
      ? await pagamentosGatewayService.solicitarReembolsoPacoteAsaas({
          pacoteId: idPacote,
          valor: item.Valor,
          motivo: item.Motivo ?? `Reembolso FisioHelp pacote #${idPacote}`,
        }, ctx)
      : await pagamentosGatewayService.solicitarReembolsoAsaas({
          transacaoId: idTransacao,
          valor: item.Valor,
          motivo: item.Motivo ?? `Reembolso FisioHelp #${item.Id}`,
        }, ctx);

    return this.marcarSolicitado(item, resultado, ctx);
  },

  async atualizarPorWebhook({ transacaoId, pacoteId = null, event, payment = null, additionalInfo = null } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    const idTransacao = toInt(transacaoId);
    const idPacote = toInt(pacoteId);
    const status = statusFromRefundEvent(event, { pacote: Boolean(idPacote && !idTransacao) });
    if ((!idTransacao && !idPacote) || !status) return null;

    const paymentId = getPaymentId(payment);
    const installmentId = getInstallmentId(payment);
    const erroNegacao = denialReasonFromAdditionalInfo(additionalInfo) ?? 'Estorno negado pelo Asaas.';

    const result = await queryWithContext(ctx, (req) => {
      req.input('TransacaoId', sql.Int, idTransacao);
      req.input('PacoteId', sql.Int, idPacote);
      req.input('Status', sql.NVarChar(30), status);
      req.input('PaymentId', sql.NVarChar(100), paymentId);
      req.input('InstallmentId', sql.NVarChar(100), installmentId);
      req.input('RefundStatus', sql.NVarChar(60), text(payment?.refundStatus ?? event, 60));
      req.input('Evento', sql.NVarChar(80), text(event, 80));
      req.input('ErroNegacao', sql.NVarChar(500), erroNegacao);
    }, `
      UPDATE dbo.FilaReembolsosGateway
      SET Status = @Status,
          GatewayPaymentId = COALESCE(@PaymentId, GatewayPaymentId),
          GatewayInstallmentId = COALESCE(@InstallmentId, GatewayInstallmentId),
          GatewayRefundStatus = COALESCE(@RefundStatus, GatewayRefundStatus),
          ProcessandoEm = NULL,
          SolicitadoEm = CASE
            WHEN @Status IN (N'Solicitado', N'Confirmado', N'Parcial', N'Negado') THEN COALESCE(SolicitadoEm, SYSDATETIME())
            ELSE SolicitadoEm
          END,
          ConfirmadoEm = CASE WHEN @Status = N'Confirmado' THEN COALESCE(ConfirmadoEm, SYSDATETIME()) ELSE ConfirmadoEm END,
          UltimoErro = CASE WHEN @Status = N'Negado' THEN @ErroNegacao ELSE NULL END,
          AtualizadoEm = SYSDATETIME()
      OUTPUT INSERTED.*
      WHERE (
          (@TransacaoId IS NOT NULL AND TransacaoId = @TransacaoId)
          OR (@TransacaoId IS NULL AND @PacoteId IS NOT NULL AND PacoteId = @PacoteId)
        )
        AND (
          Status IN (N'Pendente', N'Processando', N'Solicitado', N'FalhaTemporaria', N'Parcial')
          OR (
            Status = N'Negado'
            AND @Status IN (N'Solicitado', N'Confirmado', N'Parcial')
          )
        );
    `);

    return result?.recordset?.[0] ?? null;
  },

  async validarSolicitacaoPixRefundAsaas({ body = null } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    if (!isPixRefundAuthorization(body)) {
      return null;
    }

    const pixRefund = getPixRefundPayload(body);
    const paymentId = getPixRefundPaymentId(pixRefund, body);
    const refundId = getPixRefundId(pixRefund);
    const refundStatus = getPixRefundStatus(pixRefund) ?? 'AWAITING_CUSTOMER_EXTERNAL_AUTHORIZATION';
    const refundValue = getPixRefundValue(pixRefund, body);
    const refundDescription = getPixRefundDescription(pixRefund, body);

    if (!paymentId) {
      log('warn', 'Validação de estorno Pix Asaas sem payment.id', {
        refundId: refundId ?? null,
      });
      return {
        status: 'REFUSED',
        refuseReason: 'Estorno Pix sem payment.id reconhecido pelo FisioHelp.',
      };
    }

    const result = await queryWithContext(ctx, (req) => {
      req.input('PaymentId', sql.NVarChar(100), paymentId);
    }, `
      SELECT TOP (1)
        f.*,
        t.GatewayPaymentId AS TransacaoGatewayPaymentId,
        t.GatewayRefundValor AS TransacaoGatewayRefundValor,
        p.GatewayPaymentId AS PacoteGatewayPaymentId,
        p.GatewayRefundValor AS PacoteGatewayRefundValor
      FROM dbo.FilaReembolsosGateway f WITH (UPDLOCK, HOLDLOCK)
      LEFT JOIN dbo.Transacoes t WITH (UPDLOCK, HOLDLOCK) ON t.Id = f.TransacaoId
      LEFT JOIN dbo.Pacotes p WITH (UPDLOCK, HOLDLOCK) ON p.Id = f.PacoteId
      WHERE LTRIM(RTRIM(ISNULL(f.Provider, N''))) = N'asaas'
        AND f.Status IN (N'Pendente', N'Processando', N'Solicitado', N'FalhaTemporaria', N'Parcial', N'Negado')
        AND (
          f.GatewayPaymentId = @PaymentId
          OR t.GatewayPaymentId = @PaymentId
          OR p.GatewayPaymentId = @PaymentId
        )
      ORDER BY
        CASE f.Status WHEN N'Negado' THEN 3 ELSE 0 END,
        CASE f.Status WHEN N'Processando' THEN 0 WHEN N'Solicitado' THEN 1 ELSE 2 END,
        f.Id DESC;
    `);

    const fila = result?.recordset?.[0] ?? null;
    if (!fila) {
      log('warn', 'Validação de estorno Pix Asaas recusada: fila não encontrada', {
        paymentId,
        refundId: refundId ?? null,
      });
      return {
        status: 'REFUSED',
        refuseReason: 'Solicitação de reembolso Pix não encontrada no FisioHelp.',
      };
    }

    const valorEsperado = toMoney(
      fila.Valor ??
        fila.TransacaoGatewayRefundValor ??
        fila.PacoteGatewayRefundValor
    );
    if (refundValue !== null && valorEsperado !== null && Math.abs(refundValue - valorEsperado) > 0.01) {
      log('warn', 'Validação de estorno Pix Asaas recusada: valor divergente', {
        filaId: fila.Id,
        paymentId,
        refundValue,
        valorEsperado,
      });
      return {
        status: 'REFUSED',
        refuseReason: 'Valor do estorno Pix diverge da solicitação registrada no FisioHelp.',
      };
    }

    await queryWithContext(ctx, (req) => {
      req.input('FilaId', sql.Int, Number(fila.Id));
      req.input('PaymentId', sql.NVarChar(100), paymentId);
      req.input('RefundId', sql.NVarChar(100), refundId);
      req.input('RefundStatus', sql.NVarChar(60), refundStatus);
      req.input('RefundValor', sql.Decimal(10, 2), refundValue ?? valorEsperado);
    }, `
      UPDATE dbo.FilaReembolsosGateway
      SET Status = N'Solicitado',
          GatewayPaymentId = COALESCE(@PaymentId, GatewayPaymentId),
          GatewayRefundId = COALESCE(@RefundId, GatewayRefundId),
          GatewayRefundStatus = COALESCE(@RefundStatus, GatewayRefundStatus),
          Valor = COALESCE(@RefundValor, Valor),
          ProcessandoEm = NULL,
          SolicitadoEm = COALESCE(SolicitadoEm, SYSDATETIME()),
          UltimoErro = NULL,
          AtualizadoEm = SYSDATETIME()
      WHERE Id = @FilaId;
    `);

    const refundInfo = {
      refundId,
      status: refundStatus,
      value: refundValue ?? valorEsperado,
      description: refundDescription,
      receiptUrl: null,
    };
    const transacaoId = toInt(fila.TransacaoId);
    const pacoteId = toInt(fila.PacoteId);

    if (transacaoId) {
      await pagamentosGatewayService.atualizarGatewayReembolsoAsaas({
        transacaoId,
        paymentId,
        refundInfo,
        event: 'FISIOHELP_PIX_REFUND_AUTH_APPROVED',
        solicitado: true,
      }, ctx);
    } else if (pacoteId) {
      await pagamentosGatewayService.atualizarGatewayReembolsoPacoteAsaas({
        pacoteId,
        paymentId,
        refundInfo,
        event: 'FISIOHELP_PACKAGE_PIX_REFUND_AUTH_APPROVED',
        solicitado: true,
      }, ctx);
    }

    log('info', 'Validação de estorno Pix Asaas aprovada', {
      filaId: fila.Id,
      transacaoId: transacaoId ?? null,
      pacoteId: pacoteId ?? null,
      paymentId,
      refundId: refundId ?? null,
    });

    return { status: 'APPROVED' };
  },

  async reconciliarSolicitados({ limit = 5, minAgeMinutes = 5 } = {}, usuario = null) {
    const ctx = safeUser(usuario);
    const result = await queryWithContext(ctx, (req) => {
      req.input('Limit', sql.Int, Math.max(1, Math.min(Number(limit) || 5, 20)));
      req.input('MinAgeMinutes', sql.Int, Math.max(1, Number(minAgeMinutes) || 5));
    }, `
      SELECT TOP (@Limit) *
      FROM dbo.FilaReembolsosGateway WITH (READCOMMITTEDLOCK)
      WHERE Status = N'Solicitado'
        AND GatewayPaymentId IS NOT NULL
        AND COALESCE(SolicitadoEm, AtualizadoEm, CriadoEm) <= DATEADD(MINUTE, -@MinAgeMinutes, SYSDATETIME())
      ORDER BY COALESCE(SolicitadoEm, AtualizadoEm, CriadoEm), Id;
    `);

    const rows = result?.recordset ?? [];
    for (const row of rows) {
      try {
        const refunds = await asaasClient.listarEstornos(row.GatewayPaymentId);
        const latest = getLatestRefund(refunds);
        if (!latest) continue;

        let statusFila = mapRefundStatusToFila(latest.status);
        if (statusFila === 'Parcial' && toInt(row.PacoteId) && !toInt(row.TransacaoId)) {
          statusFila = 'Confirmado';
        }
        const refundInfo = buildRefundInfoFromAsaas(latest, row.Valor, row.Motivo);
        const pacoteId = toInt(row.PacoteId);
        const transacaoId = toInt(row.TransacaoId);

        if (pacoteId && !transacaoId) {
          if (statusFila === 'Confirmado') {
            await pagamentosGatewayService.aplicarReembolsoPacoteAsaasConfirmado({
              pacoteId,
              paymentId: row.GatewayPaymentId,
              installmentId: row.GatewayInstallmentId,
              refundInfo,
              event: 'FISIOHELP_PACKAGE_REFUND_RECONCILED',
            }, ctx);
          } else if (statusFila === 'Negado') {
            await pagamentosGatewayService.atualizarGatewayReembolsoPacoteAsaas({
              pacoteId,
              paymentId: row.GatewayPaymentId,
              installmentId: row.GatewayInstallmentId,
              refundInfo: { ...refundInfo, status: 'DENIED' },
              event: 'FISIOHELP_PACKAGE_REFUND_RECONCILED_DENIED',
              erroMensagem: 'Estorno negado pelo Asaas.',
            }, ctx);
          }
        } else {
          if (statusFila === 'Confirmado') {
            await pagamentosGatewayService.aplicarReembolsoAsaasConfirmado({
              transacaoId: row.TransacaoId,
              paymentId: row.GatewayPaymentId,
              refundInfo,
              event: 'FISIOHELP_REFUND_RECONCILED',
            }, ctx);
          } else if (statusFila === 'Parcial') {
            await pagamentosGatewayService.atualizarGatewayReembolsoAsaas({
              transacaoId: row.TransacaoId,
              paymentId: row.GatewayPaymentId,
              refundInfo: { ...refundInfo, status: 'PARTIAL' },
              event: 'FISIOHELP_REFUND_RECONCILED_PARTIAL',
            }, ctx);
          } else if (statusFila === 'Negado') {
            await pagamentosGatewayService.atualizarGatewayReembolsoAsaas({
              transacaoId: row.TransacaoId,
              paymentId: row.GatewayPaymentId,
              refundInfo: { ...refundInfo, status: 'DENIED' },
              event: 'FISIOHELP_REFUND_RECONCILED_DENIED',
              erroMensagem: 'Estorno negado pelo Asaas.',
              restaurarConsultaCancelada: true,
            }, ctx);
          }
        }

        if (statusFila) {
          await queryWithContext(ctx, (req) => {
            req.input('FilaId', sql.Int, Number(row.Id));
            req.input('Status', sql.NVarChar(30), statusFila);
            req.input('RefundId', sql.NVarChar(100), text(refundInfo.refundId, 100));
            req.input('RefundStatus', sql.NVarChar(60), text(refundInfo.status, 60));
            req.input('ReceiptUrl', sql.NVarChar(500), text(refundInfo.receiptUrl, 500));
          }, `
            UPDATE dbo.FilaReembolsosGateway
            SET Status = @Status,
                GatewayRefundId = COALESCE(@RefundId, GatewayRefundId),
                GatewayRefundStatus = COALESCE(@RefundStatus, GatewayRefundStatus),
                GatewayRefundReceiptUrl = COALESCE(@ReceiptUrl, GatewayRefundReceiptUrl),
                ConfirmadoEm = CASE WHEN @Status = N'Confirmado' THEN COALESCE(ConfirmadoEm, SYSDATETIME()) ELSE ConfirmadoEm END,
                UltimoErro = CASE WHEN @Status = N'Negado' THEN N'Estorno negado pelo Asaas.' ELSE NULL END,
                AtualizadoEm = SYSDATETIME()
            WHERE Id = @FilaId;
          `);
        }
      } catch (err) {
        log('warn', 'Falha ao reconciliar reembolso Asaas', {
          filaId: row.Id,
          transacaoId: row.TransacaoId,
          pacoteId: row.PacoteId,
          erro: err?.message,
        });
      }
    }
  },
};

export default reembolsosGatewayFilaService;
