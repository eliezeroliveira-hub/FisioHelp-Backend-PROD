//services/pagamentosGatewayService.js

import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';
import { ENV } from '../config/env.js';
import { asaasClient } from './asaasClient.js';
import notificacoesDispatch from './notificacoesDispatch.js';
import { isValidCPF, isValidEmail } from '../utils/identityValidators.js';

const ASAAS_PACOTE_MAX_PARCELAS = 10;

function safeUsuario(usuario) {
  if (!usuario) return null;
  const tipo = usuario.tipo || usuario.UsuarioTipo || usuario.userTipo;
  const id = usuario.id || usuario.UsuarioId || usuario.userId;
  return { tipo, id };
}

function isTrueBit(v) {
  return v === true || v === 1 || v === '1';
}

function normText(v) {
  return String(v ?? '').trim();
}

const STATUS_FINAL = new Set(['Cancelada', 'Concluída', 'Paciente Ausente', 'Fisioterapeuta Ausente']);

function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function nullableText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function isAsaasSandbox() {
  return /sandbox|hmlg|homolog/i.test(String(ENV.ASAAS_BASE_URL ?? ''));
}

function extractAddressNumber(address) {
  const text = nullableText(address);
  if (!text) return null;

  const commaNumber = text.match(/,\s*(\d+[A-Za-z]?)(?:\s|$)/);
  if (commaNumber?.[1]) return commaNumber[1];

  const firstNumber = text.match(/\b(\d+[A-Za-z]?)\b/);
  return firstNumber?.[1] ?? null;
}

function buildAsaasCustomerData(row) {
  const sandbox = isAsaasSandbox();
  const cpf = onlyDigits(row.PacienteCpfCnpj);
  const phone = onlyDigits(row.PacienteTelefone);
  const postalCode = onlyDigits(row.PacienteCep);

  const customerData = {
    name: nullableText(row.PacienteNome) || (sandbox ? 'Joao da Silva' : null),
    cpfCnpj: isValidCPF(cpf) ? cpf : (sandbox ? '24971563792' : null),
    email: isValidEmail(row.PacienteEmail) ? nullableText(row.PacienteEmail) : (sandbox ? 'joao.teste@fisiohelp.com.br' : null),
    phone: phone.length >= 10 ? phone : (sandbox ? '11999999999' : null),
    address: nullableText(row.PacienteEnderecoResidencial) || (sandbox ? 'Avenida Paulista' : null),
    addressNumber: extractAddressNumber(row.PacienteEnderecoResidencial) || (sandbox ? '1000' : null),
    postalCode: postalCode.length === 8 ? postalCode : (sandbox ? '01310000' : null),
    province: nullableText(row.PacienteBairroResidencial) || (sandbox ? 'Bela Vista' : null),
  };

  const faltantes = Object.entries(customerData)
    .filter(([, value]) => !nullableText(value))
    .map(([key]) => key);

  if (faltantes.length > 0) {
    throw new HttpError(
      400,
      `Dados do paciente incompletos para checkout Asaas: ${faltantes.join(', ')}.`
    );
  }

  return customerData;
}

function truncateText(value, maxLength) {
  const text = nullableText(value);
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function formatAsaasDateTime(value) {
  const raw = String(value).trim();
  if (!raw) return null;

  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
  if (match) {
    const [, year, month, day, hour, minute] = match;
    return `${day}/${month}/${year} às ${hour}:${minute}`;
  }

  return null;
}

function buildAsaasCheckoutItem(row, valor) {
  const fisioNome = nullableText(row.FisioterapeutaNome) || 'fisioterapeuta';
  const especialidade = nullableText(row.EspecialidadeNome);
  const dataHora = formatAsaasDateTime(row.ConsultaDataHoraTexto);

  const detalhes = [
    `Fisio: ${fisioNome}`,
    dataHora ? `Data/hora: ${dataHora}` : null,
    especialidade ? `Especialidade: ${especialidade}` : null,
  ].filter(Boolean);

  return {
    name: 'Consulta FisioHelp',
    description: truncateText(detalhes.join(' | '), 255),
    externalReference: row.ConsultaId ? String(row.ConsultaId) : null,
    quantity: 1,
    value: valor,
  };
}

function buildAsaasPacoteCheckoutItem(row, valor) {
  const fisioNome = nullableText(row.NomeFisioterapeuta) || 'fisioterapeuta';
  const especialidade = nullableText(row.EspecialidadeNome);
  const quantidade = Number(row.QuantidadeConsultas ?? 0) || 0;

  const detalhes = [
    `Fisio: ${fisioNome}`,
    quantidade > 0 ? `${quantidade} consultas` : null,
    especialidade ? `Especialidade: ${especialidade}` : null,
  ].filter(Boolean);

  return {
    name: 'Pacote FisioHelp',
    description: truncateText(detalhes.join(' | '), 255),
    externalReference: row.PacoteId ? `PACOTE_${row.PacoteId}` : null,
    quantity: 1,
    value: valor,
  };
}

function parsePacoteExternalReference(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^PACOTE_(\d+)$/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function mapAsaasBillingType(billingType) {
  if (billingType === 'PIX') return 'PIX';
  if (billingType === 'CREDIT_CARD') return 'CartaoCredito';
  return null;
}

function normalizeAsaasBillingType(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === 'PIX') return 'PIX';
  if (raw === 'CREDIT_CARD' || raw === 'CARTAO' || raw === 'CARTAO_CREDITO' || raw === 'CARTÃOCREDITO') {
    return 'CREDIT_CARD';
  }
  return null;
}

function montarCheckoutUrl(checkout) {
  const url = checkout?.url || checkout?.checkoutUrl || checkout?.link;
  if (url) return String(url);

  const checkoutId = String(checkout?.id ?? '').trim();
  if (!checkoutId) return null;
  return `${ENV.ASAAS_CHECKOUT_BASE_URL}?id=${encodeURIComponent(checkoutId)}`;
}

function gatewayText(value, maxLength = 100) {
  const text = nullableText(value);
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function gatewayDecimal(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function obterNetValuePagamentoAsaas(paymentId) {
  const id = gatewayText(paymentId, 100);
  if (!id) return null;

  const pagamento = await asaasClient.obterPagamento(id);
  return gatewayDecimal(pagamento?.netValue);
}

async function recalcularDecomposicaoGatewayAsaas(
  { transacaoId = null, pacoteId = null, metodoPagamento = null, gatewayValorLiquidoReal = null } = {},
  usuario
) {
  if (metodoPagamento !== 'PIX') return null;

  const transacao = Number(transacaoId);
  const pacote = Number(pacoteId);
  const temTransacao = Number.isInteger(transacao) && transacao > 0;
  const temPacote = Number.isInteger(pacote) && pacote > 0;
  if (!temTransacao && !temPacote) return null;

  const result = await queryWithContext(usuario, (req) => {
    req.input('TransacaoId', sql.Int, temTransacao ? transacao : null);
    req.input('PacoteId', sql.Int, temPacote ? pacote : null);
    req.input('MetodoPagamento', sql.NVarChar(30), metodoPagamento);
    req.input('GatewayValorLiquidoReal', sql.Decimal(18, 2), gatewayValorLiquidoReal);
    req.input('CriadoPor', sql.NVarChar(100), 'ASAAS_WEBHOOK');
    req.input(
      'Observacao',
      sql.NVarChar(500),
      gatewayValorLiquidoReal == null
        ? 'Custo gateway PIX recalculado por perfil V108.'
        : 'Custo gateway PIX recalculado com netValue real do Asaas.'
    );
  }, `
    EXEC dbo.SP_Financeiro_RecalcularDecomposicaoGatewayAsaasV108
      @TransacaoId = @TransacaoId,
      @PacoteId = @PacoteId,
      @MetodoPagamento = @MetodoPagamento,
      @GatewayValorLiquidoReal = @GatewayValorLiquidoReal,
      @CriadoPor = @CriadoPor,
      @Observacao = @Observacao;
  `);

  return result?.recordset?.[0] ?? null;
}

function moneyOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function getAsaasPaymentId(payment) {
  return gatewayText(payment?.id ?? payment?.paymentId ?? payment?.payment_id, 100);
}

function getAsaasInstallmentId(payment) {
  const installment = payment?.installment;
  return gatewayText(
    (installment && typeof installment === 'object' ? installment.id : installment) ??
      payment?.installmentId ??
      payment?.installment_id,
    100
  );
}

function getAsaasPaymentStatus(payment) {
  return gatewayText(payment?.status, 60);
}

function getAsaasCheckoutId(payment, checkout) {
  return gatewayText(
    checkout?.id ??
    payment?.checkoutSession ??
    payment?.checkout ??
    payment?.checkoutId ??
    payment?.checkout_id,
    100
  );
}

function getAsaasExternalReference(payment, checkout) {
  return gatewayText(payment?.externalReference ?? checkout?.externalReference, 100);
}

function matchesAsaasPacotePayment(payment, { pacoteId = null, checkoutId = null } = {}) {
  const paymentCheckoutId = getAsaasCheckoutId(payment, null);
  const paymentReference = getAsaasExternalReference(payment, null);
  const pacoteReference = pacoteId ? `PACOTE_${pacoteId}` : null;
  const pacoteNumericReference = pacoteId ? String(pacoteId) : null;

  return Boolean(
    (checkoutId && paymentCheckoutId === checkoutId) ||
    (pacoteReference && paymentReference === pacoteReference) ||
    (pacoteNumericReference && paymentReference === pacoteNumericReference)
  );
}

function pickAsaasPacotePayment(payments, { pacoteId = null, checkoutId = null } = {}) {
  const candidates = (Array.isArray(payments) ? payments : [])
    .filter((payment) => getAsaasPaymentId(payment))
    .filter((payment) => matchesAsaasPacotePayment(payment, { pacoteId, checkoutId }));

  return candidates.find((payment) => getAsaasInstallmentId(payment) && Number(payment?.installmentNumber) === 1) ??
    candidates.find((payment) => getAsaasInstallmentId(payment)) ??
    candidates[0] ??
    null;
}

function refundStatusFromEvent(event) {
  switch (String(event ?? '').trim().toUpperCase()) {
    case 'PAYMENT_REFUNDED':
      return 'DONE';
    case 'PAYMENT_PARTIALLY_REFUNDED':
      return 'PARTIAL';
    case 'PAYMENT_REFUND_IN_PROGRESS':
      return 'PENDING';
    case 'PAYMENT_REFUND_DENIED':
      return 'DENIED';
    default:
      return null;
  }
}

function pickLatestRefund(refunds) {
  if (!Array.isArray(refunds) || refunds.length === 0) return null;

  return [...refunds].sort((a, b) => {
    const da = Date.parse(a?.dateCreated ?? a?.createdAt ?? '') || 0;
    const db = Date.parse(b?.dateCreated ?? b?.createdAt ?? '') || 0;
    return db - da;
  })[0] ?? null;
}

function extractRefundInfo({ payment = null, response = null, event = null, fallbackValue = null, fallbackDescription = null } = {}) {
  const refunds = Array.isArray(response?.refunds)
    ? response.refunds
    : Array.isArray(payment?.refunds)
      ? payment.refunds
      : [];
  const latest = pickLatestRefund(refunds);
  const eventStatus = refundStatusFromEvent(event);
  const status = gatewayText(latest?.status ?? response?.refundStatus ?? eventStatus ?? 'REQUESTED', 60);
  const value = moneyOrNull(latest?.value ?? response?.refundValue ?? fallbackValue);
  const description = gatewayText(latest?.description ?? response?.description ?? fallbackDescription, 500);
  const receiptUrl = gatewayText(latest?.transactionReceiptUrl ?? response?.transactionReceiptUrl, 500);
  const refundId = gatewayText(latest?.id ?? response?.refundId, 100);

  return {
    refundId,
    status,
    value,
    description,
    receiptUrl,
    raw: response ?? payment ?? null,
  };
}

function denialReasonFromAdditionalInfo(additionalInfo = null) {
  return gatewayText(
    additionalInfo?.denialReason ??
      additionalInfo?.refusalReason ??
      additionalInfo?.refundDeniedReason ??
      additionalInfo?.reason,
    500
  );
}

function isRefundFinal(event, refundInfo) {
  const normalizedEvent = String(event ?? '').trim().toUpperCase();
  const normalizedStatus = String(refundInfo?.status ?? '').trim().toUpperCase();
  return normalizedEvent === 'PAYMENT_REFUNDED' || normalizedStatus === 'DONE';
}

function isRefundPartial(event, refundInfo) {
  const normalizedEvent = String(event ?? '').trim().toUpperCase();
  const normalizedStatus = String(refundInfo?.status ?? '').trim().toUpperCase();
  return normalizedEvent === 'PAYMENT_PARTIALLY_REFUNDED' || normalizedStatus === 'PARTIAL';
}

function isPacoteRefundConfirmado(event, refundInfo) {
  return isRefundFinal(event, refundInfo) || isRefundPartial(event, refundInfo);
}

async function aplicarAutoConfirmacaoConsulta(ctx, row) {
  const consultaId = Number(row?.ConsultaId ?? row?.consultaId ?? 0);
  const fisioId = Number(row?.FisioterapeutaId ?? row?.fisioterapeutaId ?? 0);
  const auto = isTrueBit(row?.ConfirmacaoAutomaticaAtual ?? row?.confirmacaoAutomaticaAtual ?? 0);
  const statusPagamento = normText(row?.StatusPagamento ?? row?.statusPagamento);
  const status = normText(row?.Status ?? row?.status);

  let autoConfirmacaoTentada = false;
  let autoConfirmacaoOk = false;
  let retornoConfirmacao = null;

  if (consultaId > 0 && fisioId > 0 && auto && statusPagamento === 'Pago') {
    if (!STATUS_FINAL.has(status) && status !== 'Confirmada') {
      autoConfirmacaoTentada = true;

      try {
        const r2 = await queryWithContext(ctx, (req) => {
          req.input('ConsultaId', sql.Int, consultaId);
          req.input('FisioterapeutaId', sql.Int, fisioId);
        }, `
          EXEC dbo.SP_ConfirmarConsulta
            @ConsultaId = @ConsultaId,
            @FisioterapeutaId = @FisioterapeutaId;
        `);

        retornoConfirmacao = r2?.recordset?.[0] ?? null;
        autoConfirmacaoOk = true;
      } catch (err) {
        autoConfirmacaoOk = false;
        retornoConfirmacao = {
          erro: err?.message ?? 'Falha ao auto-confirmar consulta'
        };
      }
    }
  }

  return {
    AutoConfirmacaoTentada: autoConfirmacaoTentada,
    AutoConfirmacaoOk: autoConfirmacaoOk,
    RetornoConfirmacao: retornoConfirmacao
  };
}

const pagamentosGatewayService = {
  /**
   * Confirma uma transação PAGA e ajusta a consulta no banco.
   *
   * Fluxo:
   * 1) EXEC dbo.SP_ConfirmarConsultaAposPagamento
   * 2) Se ConfirmacaoAutomaticaAtual = 1 e StatusPagamento = 'Pago' -> EXEC dbo.SP_ConfirmarConsulta (best-effort)
   *
   * Observação: por enquanto você está usando Admin no Postman; no futuro,
   * isso pode virar webhook do gateway (sem depender de Admin).
   */
  async confirmarTransacaoPaga(transacaoId, usuario) {
    const ctx = safeUsuario(usuario);

    if (!ctx) {
      const err = new Error('Não autenticado.');
      err.statusCode = 401;
      throw err;
    }
    if (ctx.tipo !== 'Admin') {
      const err = new Error('Acesso negado.');
      err.statusCode = 403;
      throw err;
    }

    const id = Number(transacaoId);
    if (!id) {
      const err = new Error('TransacaoId inválido.');
      err.statusCode = 400;
      throw err;
    }

    // 1) Marca transação como PAGA e ajusta a consulta (StatusPagamento/OrigemPagamento etc.)
    const result = await queryWithContext(ctx, (req) => {
      req.input('TransacaoId', sql.Int, id);
    }, `
      EXEC dbo.SP_ConfirmarConsultaAposPagamento
        @TransacaoId = @TransacaoId;
    `);

    const row = result?.recordset?.[0] ?? { TransacaoId: id };
    const autoConfirmacao = await aplicarAutoConfirmacaoConsulta(ctx, row);

    void notificacoesDispatch.pagamentoConfirmadoConsulta({
      transacaoId: id,
      consultaId: row?.ConsultaId
    });
    void notificacoesDispatch.consultaAgendada({
      consultaId: row?.ConsultaId,
      notificarPaciente: false
    });
    if (autoConfirmacao?.AutoConfirmacaoOk) {
      void notificacoesDispatch.consultaConfirmada({ consultaId: row?.ConsultaId });
    }

    return {
      ...row,
      ...autoConfirmacao
    };
  },

  // Webhook stand-by: roda como "Admin do sistema" (sem JWT)
  async confirmarTransacaoPagaStandBy(transacaoId) {
    const id = Number(transacaoId);
    if (!id) {
      throw new HttpError(400, 'TransacaoId inválido.');
    }

    const usuarioSistema = {
      tipo: 'Admin',
      id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) // ajuste no .env se quiser
    };

    return this.confirmarTransacaoPaga(id, usuarioSistema);
  },

  async criarCheckoutAsaas({ consultaId, billingType }, usuario) {
    const ctx = safeUsuario(usuario);
    if (!ctx?.id || !ctx?.tipo) {
      throw new HttpError(401, 'Não autenticado.');
    }
    if (ctx.tipo !== 'Paciente') {
      throw new HttpError(403, 'Apenas pacientes podem iniciar checkout.');
    }

    const idConsulta = Number(consultaId);
    if (!Number.isInteger(idConsulta) || idConsulta <= 0) {
      throw new HttpError(400, 'consultaId é obrigatório.');
    }

    const tipoCobranca = normalizeAsaasBillingType(billingType);
    if (!tipoCobranca) {
      throw new HttpError(400, 'Forma de pagamento inválida.');
    }

    const transacaoResult = await queryWithContext(ctx, (req) => {
      req.input('ConsultaId', sql.Int, idConsulta);
      req.input('PacienteId', sql.Int, Number(ctx.id));
    }, `
      EXEC dbo.SP_CriarTransacaoGatewayPendente
        @ConsultaId = @ConsultaId,
        @PacienteId = @PacienteId;
    `);

    const transacaoRow = transacaoResult?.recordset?.[0] ?? {};
    const transacaoId = Number(transacaoRow.TransacaoId ?? 0);
    const statusTransacao = normText(transacaoRow.Status);

    if (!transacaoId) {
      throw new HttpError(500, 'Falha ao criar transação pendente.');
    }
    if (statusTransacao === 'Pago') {
      throw new HttpError(409, 'Esta consulta já está paga.');
    }

    const dados = await queryWithContext(ctx, (req) => {
      req.input('Id', sql.Int, transacaoId);
      req.input('PacienteId', sql.Int, Number(ctx.id));
    }, `
      SELECT
        c.Id AS ConsultaId,
        CONVERT(VARCHAR(16), c.DataHora, 120) AS ConsultaDataHoraTexto,
        t.ValorTotal,
        f.Nome AS FisioterapeutaNome,
        e.Nome AS EspecialidadeNome,
        p.Nome AS PacienteNome,
        p.CPF AS PacienteCpfCnpj,
        p.Email AS PacienteEmail,
        p.Telefone AS PacienteTelefone,
        p.EnderecoResidencial AS PacienteEnderecoResidencial,
        p.Cep AS PacienteCep,
        p.BairroResidencial AS PacienteBairroResidencial
      FROM dbo.Transacoes t
      INNER JOIN dbo.Consultas c ON c.Id = t.ConsultaId
      INNER JOIN dbo.Fisioterapeutas f ON f.Id = t.FisioterapeutaId
      INNER JOIN dbo.Pacientes p ON p.Id = t.PacienteId
      LEFT JOIN dbo.Especialidades e ON e.Id = c.EspecialidadeId
      WHERE t.Id = @Id
        AND t.PacienteId = @PacienteId
        AND t.Status = N'Pendente';
    `);

    const row = dados?.recordset?.[0] ?? null;
    const valor = Number(row?.ValorTotal ?? 0);
    if (!row || !valor || valor <= 0) {
      throw new HttpError(400, 'Valor da consulta inválido.');
    }

    const customerData = buildAsaasCustomerData(row);

    const checkoutPayload = {
      billingTypes: [tipoCobranca],
      chargeTypes: ['DETACHED'],
      minutesToExpire: 60,
      externalReference: String(transacaoId),
      callback: {
        successUrl: ENV.ASAAS_SUCCESS_URL,
        cancelUrl: ENV.ASAAS_CANCEL_URL,
        expiredUrl: ENV.ASAAS_EXPIRED_URL,
      },
      items: [
        buildAsaasCheckoutItem(row, valor)
      ],
      customerData,
    };

    const checkout = await asaasClient.criarCheckout(checkoutPayload);

    const checkoutId = String(checkout?.id ?? '').trim();
    if (!checkoutId) {
      throw new HttpError(502, 'Asaas não retornou checkout.id.');
    }
    if (checkoutId.length > 50) {
      throw new HttpError(500, 'checkout.id excede o tamanho de Transacoes.CodigoTransacao.');
    }

    await queryWithContext(ctx, (req) => {
      req.input('Id', sql.Int, transacaoId);
      req.input('Codigo', sql.NVarChar(50), checkoutId);
      req.input('GatewayCheckoutId', sql.NVarChar(100), checkoutId);
      req.input('GatewayPaymentStatus', sql.NVarChar(60), gatewayText(checkout?.status, 60));
    }, `
      UPDATE dbo.Transacoes
      SET CodigoTransacao = @Codigo,
          GatewayProvider = N'asaas',
          GatewayCheckoutId = @GatewayCheckoutId,
          GatewayPaymentStatus = COALESCE(@GatewayPaymentStatus, GatewayPaymentStatus),
          GatewayAtualizadoEm = SYSDATETIME()
      WHERE Id = @Id
        AND Status = N'Pendente';
    `);

    const checkoutUrl = montarCheckoutUrl(checkout);
    if (!checkoutUrl) {
      throw new HttpError(502, 'Asaas não retornou URL de checkout.');
    }

    return {
      gateway: 'Asaas',
      transacaoId,
      checkoutId,
      checkoutUrl,
    };
  },

  async criarCheckoutPacoteAsaas({ pacoteId, billingType }, usuario) {
    const ctx = safeUsuario(usuario);
    if (!ctx?.id || !ctx?.tipo) {
      throw new HttpError(401, 'Não autenticado.');
    }
    if (ctx.tipo !== 'Paciente') {
      throw new HttpError(403, 'Apenas pacientes podem iniciar checkout de pacote.');
    }

    const idPacote = Number(pacoteId);
    if (!Number.isInteger(idPacote) || idPacote <= 0) {
      throw new HttpError(400, 'pacoteId é obrigatório.');
    }

    const tipoCobranca = normalizeAsaasBillingType(billingType);
    if (!tipoCobranca) {
      throw new HttpError(400, 'Forma de pagamento inválida.');
    }

    const dados = await queryWithContext(ctx, (req) => {
      req.input('PacoteId', sql.Int, idPacote);
      req.input('PacienteId', sql.Int, Number(ctx.id));
    }, `
      SELECT TOP (1)
        p.Id AS PacoteId,
        p.PacienteId,
        p.FisioterapeutaId,
        p.NomePacote,
        p.QuantidadeConsultas,
        p.ValorTotal,
        p.Status,
        f.Nome AS NomeFisioterapeuta,
        e.Nome AS EspecialidadeNome,
        pa.Nome AS PacienteNome,
        pa.CPF AS PacienteCpfCnpj,
        pa.Email AS PacienteEmail,
        pa.Telefone AS PacienteTelefone,
        pa.EnderecoResidencial AS PacienteEnderecoResidencial,
        pa.Cep AS PacienteCep,
        pa.BairroResidencial AS PacienteBairroResidencial
      FROM dbo.Pacotes p
      INNER JOIN dbo.Fisioterapeutas f ON f.Id = p.FisioterapeutaId
      INNER JOIN dbo.Pacientes pa ON pa.Id = p.PacienteId
      LEFT JOIN dbo.Especialidades e ON e.Id = p.EspecialidadeId
      WHERE p.Id = @PacoteId
        AND p.PacienteId = @PacienteId
        AND LTRIM(RTRIM(ISNULL(p.Status, N''))) = N'PendentePagamento';
    `);

    const row = dados?.recordset?.[0] ?? null;
    const valor = Number(row?.ValorTotal ?? 0);
    if (!row || !valor || valor <= 0) {
      throw new HttpError(400, 'Pacote pendente não encontrado ou valor inválido.');
    }

    const customerData = buildAsaasCustomerData(row);
    const checkoutParcelado = tipoCobranca === 'CREDIT_CARD';
    const checkoutPayload = {
      billingTypes: [tipoCobranca],
      chargeTypes: checkoutParcelado ? ['DETACHED', 'INSTALLMENT'] : ['DETACHED'],
      minutesToExpire: 60,
      externalReference: `PACOTE_${idPacote}`,
      callback: {
        successUrl: ENV.ASAAS_SUCCESS_URL,
        cancelUrl: ENV.ASAAS_CANCEL_URL,
        expiredUrl: ENV.ASAAS_EXPIRED_URL,
      },
      items: [
        buildAsaasPacoteCheckoutItem(row, valor)
      ],
      customerData,
    };
    if (checkoutParcelado) {
      checkoutPayload.installment = {
        maxInstallmentCount: ASAAS_PACOTE_MAX_PARCELAS,
      };
    }

    const checkout = await asaasClient.criarCheckout(checkoutPayload);
    const checkoutId = String(checkout?.id ?? '').trim();
    if (!checkoutId) {
      throw new HttpError(502, 'Asaas não retornou checkout.id.');
    }

    await queryWithContext(ctx, (req) => {
      req.input('PacoteId', sql.Int, idPacote);
      req.input('CheckoutId', sql.NVarChar(100), gatewayText(checkoutId, 100));
      req.input('GatewayStatus', sql.NVarChar(100), gatewayText(checkout?.status ?? 'ACTIVE', 100));
    }, `
      UPDATE dbo.Pacotes
      SET Gateway = N'asaas',
          GatewayCheckoutId = @CheckoutId,
          GatewayStatus = COALESCE(@GatewayStatus, GatewayStatus),
          GatewayUltimoEvento = N'ASAAS_CHECKOUT_CREATED',
          GatewayErroMensagem = NULL,
          GatewayAtualizadoEm = SYSDATETIME()
      WHERE Id = @PacoteId
        AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'PendentePagamento';
    `);

    const checkoutUrl = montarCheckoutUrl(checkout);
    if (!checkoutUrl) {
      throw new HttpError(502, 'Asaas não retornou URL de checkout.');
    }

    return {
      gateway: 'Asaas',
      pacoteId: idPacote,
      checkoutId,
      checkoutUrl,
    };
  },

  async buscarTransacaoIdPorGatewayReferencia({ checkoutId = null, paymentId = null, externalReference = null } = {}, usuario) {
    const checkoutCodigo = gatewayText(checkoutId, 100);
    const paymentCodigo = gatewayText(paymentId, 100);
    const transacaoRef = Number(externalReference);

    if (!checkoutCodigo && !paymentCodigo && !(Number.isInteger(transacaoRef) && transacaoRef > 0)) {
      return null;
    }

    const result = await queryWithContext(usuario, (req) => {
      req.input('TransacaoRef', sql.Int, Number.isInteger(transacaoRef) && transacaoRef > 0 ? transacaoRef : null);
      req.input('CheckoutId', sql.NVarChar(100), checkoutCodigo);
      req.input('PaymentId', sql.NVarChar(100), paymentCodigo);
    }, `
      SELECT TOP 1 Id
      FROM dbo.Transacoes
      WHERE
        (@TransacaoRef IS NOT NULL AND Id = @TransacaoRef)
        OR (@PaymentId IS NOT NULL AND GatewayPaymentId = @PaymentId)
        OR (
          @CheckoutId IS NOT NULL
          AND (
            GatewayCheckoutId = @CheckoutId
            OR CodigoTransacao = LEFT(@CheckoutId, 50)
          )
        )
      ORDER BY
        CASE WHEN @TransacaoRef IS NOT NULL AND Id = @TransacaoRef THEN 0 ELSE 1 END,
        Id DESC;
    `);

    const id = Number(result?.recordset?.[0]?.Id ?? 0);
    return id > 0 ? id : null;
  },

  async buscarTransacaoIdPorCheckoutId(checkoutId, usuario) {
    return this.buscarTransacaoIdPorGatewayReferencia({ checkoutId }, usuario);
  },

  async buscarPacoteIdPorGatewayReferencia({ checkoutId = null, paymentId = null, installmentId = null, externalReference = null } = {}, usuario) {
    const pacoteRef = parsePacoteExternalReference(externalReference);
    const checkoutCodigo = gatewayText(checkoutId, 100);
    const paymentCodigo = gatewayText(paymentId, 100);
    const installmentCodigo = gatewayText(installmentId, 100);

    if (!checkoutCodigo && !paymentCodigo && !installmentCodigo && !(Number.isInteger(pacoteRef) && pacoteRef > 0)) {
      return null;
    }

    const result = await queryWithContext(usuario, (req) => {
      req.input('PacoteRef', sql.Int, Number.isInteger(pacoteRef) && pacoteRef > 0 ? pacoteRef : null);
      req.input('CheckoutId', sql.NVarChar(100), checkoutCodigo);
      req.input('PaymentId', sql.NVarChar(100), paymentCodigo);
      req.input('InstallmentId', sql.NVarChar(100), installmentCodigo);
    }, `
      SELECT TOP 1 Id
      FROM dbo.Pacotes
      WHERE
        (@PacoteRef IS NOT NULL AND Id = @PacoteRef)
        OR (@PaymentId IS NOT NULL AND GatewayPaymentId = @PaymentId)
        OR (@InstallmentId IS NOT NULL AND GatewayInstallmentId = @InstallmentId)
        OR (@CheckoutId IS NOT NULL AND GatewayCheckoutId = @CheckoutId)
      ORDER BY
        CASE WHEN @PacoteRef IS NOT NULL AND Id = @PacoteRef THEN 0 ELSE 1 END,
        Id DESC;
    `);

    const id = Number(result?.recordset?.[0]?.Id ?? 0);
    return id > 0 ? id : null;
  },

  async registrarReferenciaGatewayAsaas({ transacaoId, checkoutId = null, paymentId = null, paymentStatus = null, event = null } = {}, usuario) {
    const ctx = safeUsuario(usuario) ?? usuario;
    const id = Number(transacaoId);
    if (!Number.isInteger(id) || id <= 0) return null;

    const result = await queryWithContext(ctx, (req) => {
      req.input('TransacaoId', sql.Int, id);
      req.input('CheckoutId', sql.NVarChar(100), gatewayText(checkoutId, 100));
      req.input('PaymentId', sql.NVarChar(100), gatewayText(paymentId, 100));
      req.input('PaymentStatus', sql.NVarChar(60), gatewayText(paymentStatus, 60));
      req.input('Evento', sql.NVarChar(80), gatewayText(event, 80));
    }, `
      UPDATE dbo.Transacoes
      SET GatewayProvider = N'asaas',
          GatewayCheckoutId = COALESCE(@CheckoutId, GatewayCheckoutId),
          GatewayPaymentId = COALESCE(@PaymentId, GatewayPaymentId),
          GatewayPaymentStatus = COALESCE(@PaymentStatus, GatewayPaymentStatus),
          GatewayUltimoEvento = COALESCE(@Evento, GatewayUltimoEvento),
          GatewayAtualizadoEm = SYSDATETIME()
      WHERE Id = @TransacaoId;

      SELECT TOP (1)
        Id AS TransacaoId,
        GatewayCheckoutId,
        GatewayPaymentId,
        GatewayPaymentStatus,
        GatewayUltimoEvento
      FROM dbo.Transacoes
      WHERE Id = @TransacaoId;
    `);

    return result?.recordset?.[0] ?? null;
  },

  async registrarReferenciaGatewayPacoteAsaas({ pacoteId, checkoutId = null, paymentId = null, installmentId = null, paymentStatus = null, event = null } = {}, usuario) {
    const ctx = safeUsuario(usuario) ?? usuario;
    const id = Number(pacoteId);
    if (!Number.isInteger(id) || id <= 0) return null;

    const result = await queryWithContext(ctx, (req) => {
      req.input('PacoteId', sql.Int, id);
      req.input('CheckoutId', sql.NVarChar(100), gatewayText(checkoutId, 100));
      req.input('PaymentId', sql.NVarChar(200), gatewayText(paymentId, 200));
      req.input('InstallmentId', sql.NVarChar(100), gatewayText(installmentId, 100));
      req.input('PaymentStatus', sql.NVarChar(100), gatewayText(paymentStatus, 100));
      req.input('Evento', sql.NVarChar(80), gatewayText(event, 80));
    }, `
      UPDATE dbo.Pacotes
      SET Gateway = N'asaas',
          GatewayCheckoutId = COALESCE(@CheckoutId, GatewayCheckoutId),
          GatewayPaymentId = COALESCE(@PaymentId, GatewayPaymentId),
          GatewayInstallmentId = COALESCE(@InstallmentId, GatewayInstallmentId),
          GatewayStatus = COALESCE(@PaymentStatus, GatewayStatus),
          GatewayUltimoEvento = COALESCE(@Evento, GatewayUltimoEvento),
          GatewayErroMensagem = NULL,
          GatewayAtualizadoEm = SYSDATETIME()
      WHERE Id = @PacoteId;

      SELECT TOP (1)
        Id AS PacoteId,
        Status,
        GatewayCheckoutId,
        GatewayPaymentId,
        GatewayInstallmentId,
        GatewayStatus,
        GatewayUltimoEvento
      FROM dbo.Pacotes
      WHERE Id = @PacoteId;
    `);

    return result?.recordset?.[0] ?? null;
  },

  async confirmarPagamentoAsaas(transacaoId, billingType, usuario, gatewayInfo = {}) {
    const ctx = safeUsuario(usuario);
    if (!ctx?.id || ctx.tipo !== 'Admin') {
      throw new HttpError(403, 'Acesso negado.');
    }

    const id = Number(transacaoId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'TransacaoId inválido.');
    }

    const metodo = mapAsaasBillingType(billingType);
    let gatewayValorLiquidoReal = gatewayDecimal(
      gatewayInfo?.netValue ?? gatewayInfo?.NetValue ?? gatewayInfo?.gatewayValorLiquidoReal
    );
    const result = await queryWithContext(ctx, (req) => {
      req.input('TransacaoId', sql.Int, id);
      req.input('MetodoPagamento', sql.NVarChar(20), metodo);
    }, `
      EXEC dbo.SP_ConfirmarPagamentoGatewayAsaas
        @TransacaoId = @TransacaoId,
        @MetodoPagamento = @MetodoPagamento;
    `);

    const row = result?.recordset?.[0] ?? { TransacaoId: id };

    if (metodo === 'PIX' && gatewayValorLiquidoReal == null) {
      const gatewayRowResult = await queryWithContext(ctx, (req) => {
        req.input('TransacaoId', sql.Int, id);
      }, `
        SELECT TOP (1)
          Id AS TransacaoId,
          GatewayCheckoutId,
          GatewayPaymentId,
          CodigoTransacao
        FROM dbo.Transacoes
        WHERE Id = @TransacaoId;
      `);

      const gatewayRow = gatewayRowResult?.recordset?.[0] ?? { TransacaoId: id };
      const paymentId = await this.resolverPaymentIdAsaas(gatewayRow, ctx).catch(() => null);
      gatewayValorLiquidoReal = await obterNetValuePagamentoAsaas(paymentId).catch(() => null);
    }

    await recalcularDecomposicaoGatewayAsaas({
      transacaoId: id,
      metodoPagamento: metodo,
      gatewayValorLiquidoReal,
    }, ctx);

    const autoConfirmacao = await aplicarAutoConfirmacaoConsulta(ctx, row);

    void notificacoesDispatch.pagamentoConfirmadoConsulta({
      transacaoId: id,
      consultaId: row?.ConsultaId
    });
    void notificacoesDispatch.consultaAgendada({
      consultaId: row?.ConsultaId,
      notificarPaciente: false
    });
    if (autoConfirmacao?.AutoConfirmacaoOk) {
      void notificacoesDispatch.consultaConfirmada({ consultaId: row?.ConsultaId });
    }

    return {
      ...row,
      ...autoConfirmacao
    };
  },

  async confirmarPagamentoPacoteAsaas(pacoteId, billingType, usuario, gatewayInfo = {}) {
    const ctx = safeUsuario(usuario);
    if (!ctx?.id || ctx.tipo !== 'Admin') {
      throw new HttpError(403, 'Acesso negado.');
    }

    const id = Number(pacoteId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'PacoteId inválido.');
    }

    const metodo = mapAsaasBillingType(billingType) ?? 'CartaoCredito';
    let gatewayValorLiquidoReal = gatewayDecimal(
      gatewayInfo?.netValue ?? gatewayInfo?.NetValue ?? gatewayInfo?.gatewayValorLiquidoReal
    );

    const result = await queryWithContext(ctx, (req) => {
      req.input('PacoteId', sql.Int, id);
      req.input('MetodoPagamento', sql.NVarChar(20), metodo);
    }, `
      SET NOCOUNT ON;
      SET XACT_ABORT ON;

      BEGIN TRY
        BEGIN TRAN;

        DECLARE
          @PacienteId INT,
          @ValorTotal DECIMAL(10,2),
          @StatusAtual NVARCHAR(50);

        SELECT
          @PacienteId = PacienteId,
          @ValorTotal = ValorTotal,
          @StatusAtual = LTRIM(RTRIM(ISNULL(Status, N'')))
        FROM dbo.Pacotes WITH (UPDLOCK, HOLDLOCK)
        WHERE Id = @PacoteId;

        IF @PacienteId IS NULL
          THROW 51201, N'Pacote não encontrado para confirmação de pagamento.', 1;

        IF @StatusAtual <> N'Ativo'
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM dbo.CreditosPacientes WITH (UPDLOCK, HOLDLOCK) WHERE PacoteId = @PacoteId)
          BEGIN
            EXEC dbo.SP_Pacote_GerarCreditos
              @PacoteId = @PacoteId,
              @PacienteId = @PacienteId;
          END

          UPDATE dbo.Pacotes
          SET Status = N'Ativo',
              Gateway = N'asaas',
              MetodoPagamento = @MetodoPagamento,
              GatewayStatus = N'Pago',
              ValorPago = COALESCE(ValorPago, @ValorTotal),
              PagoEm = COALESCE(PagoEm, SYSDATETIME()),
              GatewayUltimoEvento = N'ASAAS_PACKAGE_PAID',
              GatewayErroMensagem = NULL,
              GatewayAtualizadoEm = SYSDATETIME()
          WHERE Id = @PacoteId;
        END
        ELSE
        BEGIN
          UPDATE dbo.Pacotes
          SET Gateway = N'asaas',
              MetodoPagamento = COALESCE(MetodoPagamento, @MetodoPagamento),
              GatewayStatus = COALESCE(GatewayStatus, N'Pago'),
              ValorPago = COALESCE(ValorPago, @ValorTotal),
              PagoEm = COALESCE(PagoEm, SYSDATETIME()),
              GatewayUltimoEvento = N'ASAAS_PACKAGE_PAID_IDEMPOTENT',
              GatewayErroMensagem = NULL,
              GatewayAtualizadoEm = SYSDATETIME()
          WHERE Id = @PacoteId;
        END

        COMMIT;

        BEGIN TRY
          EXEC dbo.SP_Financeiro_RegistrarPacotePago
            @PacoteId = @PacoteId,
            @CriadoPor = N'ASAAS_WEBHOOK',
            @Silencioso = 1;
        END TRY
        BEGIN CATCH
          -- Snapshot financeiro é idempotente/best-effort no webhook.
        END CATCH

        SELECT TOP (1)
          Id AS PacoteId,
          Status,
          ValorPago,
          PagoEm,
          Gateway,
          MetodoPagamento,
          GatewayPaymentId,
          GatewayCheckoutId,
          GatewayInstallmentId,
          GatewayStatus
        FROM dbo.Pacotes
        WHERE Id = @PacoteId;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH
    `);

    if (metodo === 'PIX' && gatewayValorLiquidoReal == null) {
      const gatewayRow = result?.recordset?.[0] ?? { PacoteId: id };
      const pagamento = await this.resolverPaymentIdAsaasPacote(gatewayRow, ctx).catch(() => null);
      gatewayValorLiquidoReal = await obterNetValuePagamentoAsaas(pagamento?.paymentId).catch(() => null);
    }

    await recalcularDecomposicaoGatewayAsaas({
      pacoteId: id,
      metodoPagamento: metodo,
      gatewayValorLiquidoReal,
    }, ctx);

    void notificacoesDispatch.pagamentoConfirmadoPacote({ pacoteId: id });

    return result?.recordset?.[0] ?? { PacoteId: id, Status: 'Ativo' };
  },

  async cancelarTransacaoGatewayPendente(transacaoId, usuario) {
    const ctx = safeUsuario(usuario);
    if (!ctx?.id || ctx.tipo !== 'Admin') {
      throw new HttpError(403, 'Acesso negado.');
    }

    const id = Number(transacaoId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'TransacaoId inválido.');
    }

    await queryWithContext(ctx, (req) => {
      req.input('Id', sql.Int, id);
    }, `
      UPDATE dbo.Transacoes
      SET Status = N'Cancelado'
      WHERE Id = @Id
        AND Status = N'Pendente';
    `);

    return { TransacaoId: id, Cancelada: true };
  },

  async cancelarCheckoutPacotePendente({ pacoteId, motivo = null } = {}, usuario) {
    const ctx = safeUsuario(usuario);
    if (!ctx?.id || !ctx.tipo) {
      throw new HttpError(401, 'Não autenticado.');
    }

    const isPaciente = ctx.tipo === 'Paciente';
    const isAdmin = ctx.tipo === 'Admin';
    if (!isPaciente && !isAdmin) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const id = Number(pacoteId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'PacoteId inválido.');
    }

    const resultado = await queryWithContext(ctx, (req) => {
      req.input('PacoteId', sql.Int, id);
      req.input('PacienteId', sql.Int, isPaciente ? Number(ctx.id) : null);
      req.input('Motivo', sql.NVarChar(500), gatewayText(motivo, 500));
    }, `
      DECLARE @Pacote TABLE (
        PacoteId INT,
        StatusAnterior NVARCHAR(50),
        PacoteCancelado BIT
      );

      UPDATE dbo.Pacotes
      SET Status = N'Cancelado',
          CanceladoEm = COALESCE(CanceladoEm, SYSDATETIME()),
          GatewayStatus = N'Cancelado',
          GatewayUltimoEvento = N'CHECKOUT_ABANDONADO_APP',
          GatewayErroMensagem = @Motivo,
          GatewayAtualizadoEm = SYSDATETIME()
      OUTPUT inserted.Id, deleted.Status, CAST(1 AS bit)
      INTO @Pacote (PacoteId, StatusAnterior, PacoteCancelado)
      WHERE Id = @PacoteId
        AND (@PacienteId IS NULL OR PacienteId = @PacienteId)
        AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'PendentePagamento';

      IF NOT EXISTS (SELECT 1 FROM @Pacote)
      BEGIN
        INSERT INTO @Pacote (PacoteId, StatusAnterior, PacoteCancelado)
        SELECT TOP (1)
          Id,
          Status,
          CAST(0 AS bit)
        FROM dbo.Pacotes
        WHERE Id = @PacoteId
          AND (@PacienteId IS NULL OR PacienteId = @PacienteId);
      END

      SELECT TOP (1)
        PacoteId,
        StatusAnterior,
        PacoteCancelado,
        CASE
          WHEN PacoteCancelado = 1 THEN N'Checkout encerrado. O pacote pendente foi cancelado.'
          ELSE N'Nenhum pacote pendente foi cancelado.'
        END AS Mensagem
      FROM @Pacote;
    `);

    const row = resultado?.recordset?.[0] ?? {};
    return {
      PacoteId: Number(row.PacoteId ?? id) || null,
      PacoteCancelado: row.PacoteCancelado === true || row.PacoteCancelado === 1,
      StatusAnterior: row.StatusAnterior ?? null,
      Mensagem: row.Mensagem ?? 'Checkout de pacote abandonado.'
    };
  },

  async buscarTransacaoGatewayParaReembolso(transacaoId, usuario) {
    const ctx = safeUsuario(usuario);
    const id = Number(transacaoId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'TransacaoId inválido.');
    }

    const result = await queryWithContext(ctx, (req) => {
      req.input('TransacaoId', sql.Int, id);
      req.input('PacienteId', sql.Int, ctx?.tipo === 'Paciente' ? Number(ctx.id) : null);
    }, `
      SELECT TOP (1)
        t.Id AS TransacaoId,
        t.ConsultaId,
        t.PacienteId,
        t.FisioterapeutaId,
        t.ValorTotal,
        LTRIM(RTRIM(ISNULL(t.MetodoPagamento, N''))) AS MetodoPagamento,
        LTRIM(RTRIM(ISNULL(t.Status, N''))) AS Status,
        t.CodigoTransacao,
        t.GatewayProvider,
        t.GatewayCheckoutId,
        t.GatewayPaymentId,
        t.GatewayPaymentStatus,
        t.GatewayRefundStatus,
        t.GatewayRefundValor,
        c.PagamentoViaPlataforma,
        LTRIM(RTRIM(ISNULL(c.OrigemPagamento, N''))) AS OrigemPagamento,
        LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))) AS StatusPagamento
      FROM dbo.Transacoes t
      INNER JOIN dbo.Consultas c ON c.Id = t.ConsultaId
      WHERE t.Id = @TransacaoId
        AND (@PacienteId IS NULL OR t.PacienteId = @PacienteId);
    `);

    const row = result?.recordset?.[0] ?? null;
    if (!row) {
      throw new HttpError(404, 'Transação não encontrada.');
    }
    return row;
  },

  async resolverPaymentIdAsaas(row, usuario) {
    const existente = gatewayText(row?.GatewayPaymentId, 100);
    if (existente) return existente;

    const transacaoId = Number(row?.TransacaoId ?? row?.Id ?? 0);
    const checkoutId = gatewayText(row?.GatewayCheckoutId ?? row?.CodigoTransacao, 100);
    const buscas = [];

    if (transacaoId > 0) {
      buscas.push({ externalReference: String(transacaoId), limit: 10 });
    }
    if (checkoutId) {
      buscas.push({ checkoutSession: checkoutId, limit: 10 });
    }

    for (const params of buscas) {
      const listagem = await asaasClient.listarPagamentos(params);
      const pagamento = Array.isArray(listagem?.data) ? listagem.data[0] : null;
      const paymentId = getAsaasPaymentId(pagamento);
      if (paymentId) {
        await this.registrarReferenciaGatewayAsaas({
          transacaoId,
          checkoutId,
          paymentId,
          paymentStatus: getAsaasPaymentStatus(pagamento),
          event: 'ASAAS_PAYMENT_RESOLVED'
        }, usuario);
        return paymentId;
      }
    }

    throw new HttpError(
      409,
      'Não foi possível localizar o payment.id do Asaas para esta transação. Aguarde o webhook de pagamento ou confira a cobrança no Asaas.'
    );
  },

  async buscarPacoteGatewayParaReembolso(pacoteId, usuario) {
    const ctx = safeUsuario(usuario);
    const id = Number(pacoteId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'PacoteId inválido.');
    }

    const result = await queryWithContext(ctx, (req) => {
      req.input('PacoteId', sql.Int, id);
      req.input('PacienteId', sql.Int, ctx?.tipo === 'Paciente' ? Number(ctx.id) : null);
    }, `
      SELECT TOP (1)
        p.Id AS PacoteId,
        p.PacienteId,
        p.FisioterapeutaId,
        p.ValorTotal,
        p.ValorPago,
        LTRIM(RTRIM(ISNULL(p.Status, N''))) AS Status,
        LTRIM(RTRIM(ISNULL(p.Gateway, N''))) AS Gateway,
        p.GatewayCheckoutId,
        p.GatewayPaymentId,
        p.GatewayInstallmentId,
        LTRIM(RTRIM(ISNULL(p.GatewayStatus, N''))) AS GatewayStatus,
        LTRIM(RTRIM(ISNULL(p.GatewayRefundStatus, N''))) AS GatewayRefundStatus,
        p.GatewayRefundValor,
        CONVERT(VARCHAR(10), DATEADD(DAY, -1, COALESCE(p.PagoEm, p.CriadoEm, p.DataCompra, SYSDATETIME())), 23) AS GatewayBuscaDataInicio,
        CONVERT(VARCHAR(10), DATEADD(DAY, 1, COALESCE(p.PagoEm, p.CriadoEm, p.DataCompra, SYSDATETIME())), 23) AS GatewayBuscaDataFim
      FROM dbo.Pacotes p
      WHERE p.Id = @PacoteId
        AND (@PacienteId IS NULL OR p.PacienteId = @PacienteId);
    `);

    const row = result?.recordset?.[0] ?? null;
    if (!row) {
      throw new HttpError(404, 'Pacote não encontrado.');
    }
    return row;
  },

  async resolverPaymentIdAsaasPacote(row, usuario) {
    const existente = gatewayText(row?.GatewayPaymentId, 100);
    const installmentExistente = gatewayText(row?.GatewayInstallmentId, 100);
    if (installmentExistente) {
      return { paymentId: existente, installmentId: installmentExistente };
    }

    const pacoteId = Number(row?.PacoteId ?? row?.Id ?? 0);
    const checkoutId = gatewayText(row?.GatewayCheckoutId, 100);
    const dataInicio = gatewayText(row?.GatewayBuscaDataInicio, 10);
    const dataFim = gatewayText(row?.GatewayBuscaDataFim, 10);
    const buscas = [];

    if (pacoteId > 0) {
      buscas.push({ externalReference: `PACOTE_${pacoteId}`, limit: 10 });
      buscas.push({ externalReference: String(pacoteId), limit: 10 });
    }
    if (checkoutId) {
      buscas.push({ checkoutSession: checkoutId, limit: 10 });
    }
    if ((checkoutId || pacoteId > 0) && dataInicio && dataFim) {
      buscas.push({ 'dateCreated[ge]': dataInicio, 'dateCreated[le]': dataFim, limit: 100 });
    }

    for (const params of buscas) {
      const listagem = await asaasClient.listarPagamentos(params);
      const pagamentos = Array.isArray(listagem?.data) ? listagem.data : [];
      const buscaPorData = Boolean(params['dateCreated[ge]'] || params['dateCreated[le]']);
      const pagamento = pickAsaasPacotePayment(pagamentos, { pacoteId, checkoutId }) ??
        (!buscaPorData ? pagamentos.find((item) => getAsaasPaymentId(item)) : null) ??
        null;
      const paymentId = getAsaasPaymentId(pagamento);
      const installmentId = getAsaasInstallmentId(pagamento);
      if (paymentId) {
        await this.registrarReferenciaGatewayPacoteAsaas({
          pacoteId,
          checkoutId,
          paymentId,
          installmentId,
          paymentStatus: getAsaasPaymentStatus(pagamento),
          event: 'ASAAS_PACKAGE_PAYMENT_RESOLVED'
        }, usuario);
        return { paymentId, installmentId };
      }
    }

    if (existente) {
      return { paymentId: existente, installmentId: null };
    }

    throw new HttpError(
      409,
      'Não foi possível localizar o payment.id do Asaas para este pacote. Aguarde o webhook de pagamento ou confira a cobrança no Asaas.'
    );
  },

  async atualizarGatewayReembolsoPacoteAsaas({
    pacoteId,
    paymentId = null,
    installmentId = null,
    paymentStatus = null,
    refundInfo = {},
    event = null,
    erroMensagem = null,
    solicitado = false,
    confirmado = false,
  } = {}, usuario) {
    const ctx = safeUsuario(usuario) ?? usuario;
    const id = Number(pacoteId);
    if (!Number.isInteger(id) || id <= 0) return null;

    const result = await queryWithContext(ctx, (req) => {
      req.input('PacoteId', sql.Int, id);
      req.input('PaymentId', sql.NVarChar(100), gatewayText(paymentId, 100));
      req.input('InstallmentId', sql.NVarChar(100), gatewayText(installmentId, 100));
      req.input('PaymentStatus', sql.NVarChar(100), gatewayText(paymentStatus, 100));
      req.input('RefundStatus', sql.NVarChar(60), gatewayText(refundInfo?.status, 60));
      req.input('RefundId', sql.NVarChar(100), gatewayText(refundInfo?.refundId, 100));
      req.input('RefundValor', sql.Decimal(10, 2), moneyOrNull(refundInfo?.value));
      req.input('RefundDescricao', sql.NVarChar(500), gatewayText(refundInfo?.description, 500));
      req.input('RefundReceiptUrl', sql.NVarChar(500), gatewayText(refundInfo?.receiptUrl, 500));
      req.input('Evento', sql.NVarChar(80), gatewayText(event, 80));
      req.input('ErroMensagem', sql.NVarChar(500), gatewayText(erroMensagem, 500));
      req.input('Solicitado', sql.Bit, solicitado ? 1 : 0);
      req.input('Confirmado', sql.Bit, confirmado ? 1 : 0);
    }, `
      UPDATE dbo.Pacotes
      SET Gateway = N'asaas',
          GatewayPaymentId = COALESCE(@PaymentId, GatewayPaymentId),
          GatewayInstallmentId = COALESCE(@InstallmentId, GatewayInstallmentId),
          GatewayStatus = CASE
            WHEN @Confirmado = 1 THEN N'ReembolsoConfirmado'
            WHEN @ErroMensagem IS NOT NULL THEN N'ReembolsoFalhou'
            WHEN @Solicitado = 1 THEN N'ReembolsoSolicitado'
            ELSE GatewayStatus
          END,
          GatewayRefundStatus = COALESCE(@RefundStatus, GatewayRefundStatus),
          GatewayRefundId = COALESCE(@RefundId, GatewayRefundId),
          GatewayRefundValor = COALESCE(GatewayRefundValor, @RefundValor),
          GatewayRefundDescricao = COALESCE(@RefundDescricao, GatewayRefundDescricao),
          GatewayRefundReceiptUrl = COALESCE(@RefundReceiptUrl, GatewayRefundReceiptUrl),
          GatewayRefundSolicitadoEm = CASE
            WHEN @Solicitado = 1 THEN COALESCE(GatewayRefundSolicitadoEm, SYSDATETIME())
            ELSE GatewayRefundSolicitadoEm
          END,
          GatewayRefundConfirmadoEm = CASE
            WHEN @Confirmado = 1 THEN COALESCE(GatewayRefundConfirmadoEm, SYSDATETIME())
            ELSE GatewayRefundConfirmadoEm
          END,
          GatewayUltimoEvento = COALESCE(@Evento, GatewayUltimoEvento),
          GatewayErroMensagem = @ErroMensagem,
          GatewayAtualizadoEm = SYSDATETIME()
      WHERE Id = @PacoteId;

      SELECT TOP (1)
        Id AS PacoteId,
        Status,
        GatewayPaymentId,
        GatewayInstallmentId,
        GatewayStatus,
        GatewayRefundStatus,
        GatewayRefundValor,
        GatewayRefundConfirmadoEm,
        GatewayErroMensagem
      FROM dbo.Pacotes
      WHERE Id = @PacoteId;
    `);

    return result?.recordset?.[0] ?? null;
  },

  async aplicarReembolsoPacoteAsaasConfirmado({ pacoteId, paymentId = null, installmentId = null, paymentStatus = null, refundInfo = {}, event = null } = {}, usuario) {
    const ctx = safeUsuario(usuario) ?? usuario;
    const id = Number(pacoteId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'PacoteId inválido.');
    }

    const atualizado = await this.atualizarGatewayReembolsoPacoteAsaas({
      pacoteId: id,
      paymentId,
      installmentId,
      paymentStatus,
      refundInfo: {
        ...refundInfo,
        status: refundInfo?.status ?? 'DONE',
      },
      event: event ?? 'PAYMENT_REFUNDED',
      confirmado: true,
    }, ctx);

    await notificacoesDispatch.reembolsoPacoteConcluido({ pacoteId: id });

    return atualizado;
  },

  async solicitarReembolsoPacoteAsaas({ pacoteId, valor = null, motivo = null } = {}, usuario) {
    const ctx = safeUsuario(usuario);
    if (!ctx?.id || !ctx?.tipo) {
      throw new HttpError(401, 'Não autenticado.');
    }
    if (!['Admin', 'Paciente'].includes(ctx.tipo)) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const row = await this.buscarPacoteGatewayParaReembolso(pacoteId, ctx);
    const status = normText(row.Status);
    const gateway = normText(row.Gateway).toLowerCase();
    const refundStatus = normText(row.GatewayRefundStatus).toUpperCase();
    const valorPago = moneyOrNull(row.ValorPago ?? row.ValorTotal);
    const valorSolicitado = moneyOrNull(valor);

    if (!['Cancelado', 'Ativo'].includes(status)) {
      throw new HttpError(409, `O pacote precisa estar Ativo ou Cancelado para estornar no Asaas (status atual: ${status || 'N/A'}).`);
    }
    if (gateway && gateway !== 'asaas') {
      throw new HttpError(400, 'Reembolso Asaas indisponível para pacote pago fora do Asaas.');
    }
    if (!valorPago) {
      throw new HttpError(400, 'Pacote sem valor pago para estorno.');
    }
    if (valorSolicitado && valorSolicitado > valorPago) {
      throw new HttpError(400, 'Valor de estorno maior que o valor pago do pacote.');
    }
    if (['PENDING', 'REQUESTED', 'IN_PROGRESS'].includes(refundStatus)) {
      throw new HttpError(409, 'Já existe uma solicitação de estorno Asaas em processamento para este pacote.');
    }
    if (['DONE', 'PARTIAL'].includes(refundStatus)) {
      return {
        pacoteId: Number(row.PacoteId),
        status: 'ReembolsoConfirmado',
        gatewayRefundStatus: refundStatus,
        gatewayRefundValor: moneyOrNull(row.GatewayRefundValor),
        reembolsoConfirmado: true,
        mensagem: 'Pacote já estava com estorno confirmado no Asaas.'
      };
    }

    const { paymentId, installmentId } = await this.resolverPaymentIdAsaasPacote(row, ctx);
    const refundPayload = {
      description: gatewayText(motivo || `Estorno FisioHelp do pacote #${row.PacoteId}`, 255),
    };

    if (valorSolicitado && valorSolicitado < valorPago) {
      refundPayload.value = valorSolicitado;
    }

    let respostaAsaas;
    try {
      if (installmentId) {
        const installmentPayload = {};
        if (refundPayload.value) installmentPayload.value = refundPayload.value;
        respostaAsaas = await asaasClient.estornarParcelamento(installmentId, installmentPayload);
      } else {
        respostaAsaas = await asaasClient.estornarPagamento(paymentId, refundPayload);
      }
    } catch (err) {
      await this.atualizarGatewayReembolsoPacoteAsaas({
        pacoteId: row.PacoteId,
        paymentId,
        installmentId,
        refundInfo: {
          status: 'REQUEST_FAILED',
          value: valorSolicitado ?? valorPago,
          description: refundPayload.description,
        },
        event: 'ASAAS_PACKAGE_REFUND_REQUEST_FAILED',
        erroMensagem: err?.message ?? 'Falha ao solicitar estorno Asaas do pacote',
      }, ctx).catch(() => {});

      throw err;
    }

    const refundInfo = extractRefundInfo({
      response: respostaAsaas,
      fallbackValue: valorSolicitado ?? valorPago,
      fallbackDescription: refundPayload.description,
    });
    const refundInfoPacote = {
      ...refundInfo,
      value: valorSolicitado ?? refundInfo.value ?? valorPago,
    };
    const paymentStatus = getAsaasPaymentStatus(respostaAsaas);

    await this.atualizarGatewayReembolsoPacoteAsaas({
      pacoteId: row.PacoteId,
      paymentId,
      installmentId,
      paymentStatus,
      refundInfo: refundInfoPacote,
      event: 'ASAAS_PACKAGE_REFUND_REQUESTED',
      solicitado: true,
    }, ctx);

    await notificacoesDispatch.reembolsoPacoteSolicitado({ pacoteId: row.PacoteId });

    if (isPacoteRefundConfirmado(null, refundInfoPacote)) {
      await this.aplicarReembolsoPacoteAsaasConfirmado({
        pacoteId: row.PacoteId,
        paymentId,
        installmentId,
        paymentStatus,
        refundInfo: refundInfoPacote,
        event: 'ASAAS_PACKAGE_REFUND_CONFIRMED_SYNC',
      }, ctx);
    }

    return {
      pacoteId: Number(row.PacoteId),
      paymentId,
      installmentId,
      gatewayRefundStatus: refundInfoPacote.status,
      gatewayRefundValor: refundInfoPacote.value,
      reembolsoConfirmado: isPacoteRefundConfirmado(null, refundInfoPacote),
      respostaAsaas,
    };
  },

  async processarWebhookReembolsoPacoteAsaas({ pacoteId, payment = null, event = null, additionalInfo = null } = {}, usuario) {
    const ctx = safeUsuario(usuario) ?? usuario;
    const id = Number(pacoteId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'PacoteId inválido.');
    }

    const paymentId = getAsaasPaymentId(payment);
    const installmentId = getAsaasInstallmentId(payment);
    const paymentStatus = getAsaasPaymentStatus(payment);
    const refundInfo = extractRefundInfo({ payment, event });

    if (isPacoteRefundConfirmado(event, refundInfo)) {
      return this.aplicarReembolsoPacoteAsaasConfirmado({
        pacoteId: id,
        paymentId,
        installmentId,
        paymentStatus,
        refundInfo,
        event,
      }, ctx);
    }

    if (String(event ?? '').trim().toUpperCase() === 'PAYMENT_REFUND_DENIED') {
      const denialReason = denialReasonFromAdditionalInfo(additionalInfo);
      const atualizado = await this.atualizarGatewayReembolsoPacoteAsaas({
        pacoteId: id,
        paymentId,
        installmentId,
        paymentStatus,
        refundInfo: { ...refundInfo, status: 'DENIED' },
        event,
        erroMensagem: denialReason ?? refundInfo?.description ?? 'Estorno negado pelo Asaas.',
      }, ctx);

      await notificacoesDispatch.reembolsoPacoteNegado({
        pacoteId: id,
        motivo: denialReason ?? refundInfo?.description ?? 'Estorno negado pelo Asaas.'
      });

      return atualizado;
    }

    return this.atualizarGatewayReembolsoPacoteAsaas({
      pacoteId: id,
      paymentId,
      installmentId,
      paymentStatus,
      refundInfo,
      event,
      solicitado: String(event ?? '').trim().toUpperCase() === 'PAYMENT_REFUND_IN_PROGRESS',
    }, ctx);
  },

  async atualizarGatewayReembolsoAsaas({
    transacaoId,
    paymentId = null,
    paymentStatus = null,
    refundInfo = {},
    event = null,
    erroMensagem = null,
    solicitado = false,
    confirmado = false,
    restaurarConsultaCancelada = false,
  } = {}, usuario) {
    const ctx = safeUsuario(usuario) ?? usuario;
    const id = Number(transacaoId);
    if (!Number.isInteger(id) || id <= 0) return null;

    const result = await queryWithContext(ctx, (req) => {
      req.input('TransacaoId', sql.Int, id);
      req.input('PaymentId', sql.NVarChar(100), gatewayText(paymentId, 100));
      req.input('PaymentStatus', sql.NVarChar(60), gatewayText(paymentStatus, 60));
      req.input('RefundStatus', sql.NVarChar(60), gatewayText(refundInfo?.status, 60));
      req.input('RefundId', sql.NVarChar(100), gatewayText(refundInfo?.refundId, 100));
      req.input('RefundValor', sql.Decimal(10, 2), moneyOrNull(refundInfo?.value));
      req.input('RefundDescricao', sql.NVarChar(500), gatewayText(refundInfo?.description, 500));
      req.input('RefundReceiptUrl', sql.NVarChar(500), gatewayText(refundInfo?.receiptUrl, 500));
      req.input('Evento', sql.NVarChar(80), gatewayText(event, 80));
      req.input('ErroMensagem', sql.NVarChar(500), gatewayText(erroMensagem, 500));
      req.input('Solicitado', sql.Bit, solicitado ? 1 : 0);
      req.input('Confirmado', sql.Bit, confirmado ? 1 : 0);
      req.input('RestaurarConsultaCancelada', sql.Bit, restaurarConsultaCancelada ? 1 : 0);
    }, `
      SET NOCOUNT ON;

      UPDATE dbo.Transacoes
      SET GatewayProvider = N'asaas',
          GatewayPaymentId = COALESCE(@PaymentId, GatewayPaymentId),
          GatewayPaymentStatus = COALESCE(@PaymentStatus, GatewayPaymentStatus),
          GatewayRefundStatus = COALESCE(@RefundStatus, GatewayRefundStatus),
          GatewayRefundId = COALESCE(@RefundId, GatewayRefundId),
          GatewayRefundValor = COALESCE(@RefundValor, GatewayRefundValor),
          GatewayRefundDescricao = COALESCE(@RefundDescricao, GatewayRefundDescricao),
          GatewayRefundReceiptUrl = COALESCE(@RefundReceiptUrl, GatewayRefundReceiptUrl),
          GatewayRefundSolicitadoEm = CASE
            WHEN @Solicitado = 1 THEN COALESCE(GatewayRefundSolicitadoEm, SYSDATETIME())
            ELSE GatewayRefundSolicitadoEm
          END,
          GatewayRefundConfirmadoEm = CASE
            WHEN @Confirmado = 1 THEN COALESCE(GatewayRefundConfirmadoEm, SYSDATETIME())
            ELSE GatewayRefundConfirmadoEm
          END,
          GatewayUltimoEvento = COALESCE(@Evento, GatewayUltimoEvento),
          GatewayErroMensagem = @ErroMensagem,
          GatewayAtualizadoEm = SYSDATETIME()
      WHERE Id = @TransacaoId;

      IF @RestaurarConsultaCancelada = 1
      BEGIN
        DECLARE @ConsultasRestauradas TABLE (ConsultaId INT NOT NULL PRIMARY KEY);

        UPDATE c
        SET Status = N'Aguardando',
            DataEncerramento = NULL,
            MotivoEncerramento = NULL
        OUTPUT inserted.Id INTO @ConsultasRestauradas (ConsultaId)
        FROM dbo.Consultas c
        INNER JOIN dbo.Transacoes t ON t.ConsultaId = c.Id
        WHERE t.Id = @TransacaoId
          AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pago'
          AND LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Cancelada'
          AND LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))) = N'Pago'
          AND c.DataHora > SYSDATETIME()
          AND (
            c.MotivoEncerramento LIKE N'%reembolso Asaas%'
            OR c.MotivoEncerramento LIKE N'%reembolso%'
            OR c.MotivoEncerramento LIKE N'%estorno%'
          );

        IF OBJECT_ID('dbo.ConsultasLogs', 'U') IS NOT NULL
          AND EXISTS (SELECT 1 FROM @ConsultasRestauradas)
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.ConsultasLogs cl
            INNER JOIN @ConsultasRestauradas cr ON cr.ConsultaId = cl.ConsultaId
            WHERE 1 = 1
              AND cl.Evento = N'ReembolsoNegado'
          )
        BEGIN
          INSERT INTO dbo.ConsultasLogs (ConsultaId, Evento, Descricao, DataHora, UsuarioTipo, UsuarioId)
          SELECT
            cr.ConsultaId,
            N'ReembolsoNegado',
            LEFT(COALESCE(@ErroMensagem, N'Estorno negado pelo Asaas.'), 400),
            SYSDATETIME(),
            N'Admin',
            TRY_CONVERT(INT, SESSION_CONTEXT(N'UsuarioId'))
          FROM @ConsultasRestauradas cr;
        END
      END

      SELECT TOP (1)
        Id AS TransacaoId,
        Status,
        GatewayPaymentId,
        GatewayRefundStatus,
        GatewayRefundValor,
        GatewayRefundConfirmadoEm,
        GatewayErroMensagem
      FROM dbo.Transacoes
      WHERE Id = @TransacaoId;
    `);

    return result?.recordset?.[0] ?? null;
  },

  async aplicarReembolsoAsaasConfirmado({ transacaoId, paymentId = null, paymentStatus = null, refundInfo = {}, event = null } = {}, usuario) {
    const ctx = safeUsuario(usuario) ?? usuario;
    const id = Number(transacaoId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'TransacaoId inválido.');
    }

    const result = await queryWithContext(ctx, (req) => {
      req.input('TransacaoId', sql.Int, id);
      req.input('PaymentId', sql.NVarChar(100), gatewayText(paymentId, 100));
      req.input('PaymentStatus', sql.NVarChar(60), gatewayText(paymentStatus, 60));
      req.input('RefundStatus', sql.NVarChar(60), gatewayText(refundInfo?.status ?? 'DONE', 60));
      req.input('RefundId', sql.NVarChar(100), gatewayText(refundInfo?.refundId, 100));
      req.input('RefundValor', sql.Decimal(10, 2), moneyOrNull(refundInfo?.value));
      req.input('RefundDescricao', sql.NVarChar(500), gatewayText(refundInfo?.description, 500));
      req.input('RefundReceiptUrl', sql.NVarChar(500), gatewayText(refundInfo?.receiptUrl, 500));
      req.input('Evento', sql.NVarChar(80), gatewayText(event ?? 'PAYMENT_REFUNDED', 80));
    }, `
      SET NOCOUNT ON;
      SET XACT_ABORT ON;

      BEGIN TRY
        BEGIN TRAN;

        DECLARE
          @ConsultaId INT = NULL,
          @StatusAtual NVARCHAR(20) = NULL,
          @Observacao NVARCHAR(500) = LEFT(
            CONCAT(
              N'Estorno Asaas confirmado',
              CASE WHEN @PaymentId IS NULL THEN N'' ELSE CONCAT(N' | paymentId=', @PaymentId) END,
              CASE WHEN @RefundStatus IS NULL THEN N'' ELSE CONCAT(N' | refundStatus=', @RefundStatus) END,
              CASE WHEN @RefundValor IS NULL THEN N'' ELSE CONCAT(N' | valor=', CONVERT(NVARCHAR(40), @RefundValor)) END
            ),
            500
          );

        SELECT
          @ConsultaId = ConsultaId,
          @StatusAtual = LTRIM(RTRIM(ISNULL(Status, N'')))
        FROM dbo.Transacoes WITH (UPDLOCK, HOLDLOCK)
        WHERE Id = @TransacaoId;

        IF @ConsultaId IS NULL
          THROW 51120, 'Transação não encontrada para confirmar reembolso.', 1;

        IF OBJECT_ID('dbo.Repasses', 'U') IS NOT NULL
        BEGIN
          UPDATE dbo.Repasses
          SET Status = N'Cancelado'
          WHERE TransacaoId = @TransacaoId
            AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'Pendente';
        END

        IF OBJECT_ID('dbo.Repasses', 'U') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM dbo.Repasses WITH (READCOMMITTEDLOCK)
            WHERE TransacaoId = @TransacaoId
              AND LTRIM(RTRIM(ISNULL(Status, N''))) = N'Pago'
          )
          AND OBJECT_ID('dbo.SP_RegistrarClawbackSeRepassePago', 'P') IS NOT NULL
        BEGIN
          BEGIN TRY
            EXEC dbo.SP_RegistrarClawbackSeRepassePago
              @ConsultaId = @ConsultaId,
              @DisputaId = NULL,
              @Motivo = @Observacao;
          END TRY
          BEGIN CATCH
            -- Clawback e best-effort: nao deve bloquear a conciliacao do estorno.
          END CATCH
        END

        UPDATE dbo.Transacoes
        SET Status = N'Reembolsado',
            GatewayProvider = N'asaas',
            GatewayPaymentId = COALESCE(@PaymentId, GatewayPaymentId),
            GatewayPaymentStatus = COALESCE(@PaymentStatus, GatewayPaymentStatus),
            GatewayRefundStatus = COALESCE(@RefundStatus, GatewayRefundStatus, N'DONE'),
            GatewayRefundId = COALESCE(@RefundId, GatewayRefundId),
            GatewayRefundValor = COALESCE(@RefundValor, GatewayRefundValor, ValorTotal),
            GatewayRefundDescricao = COALESCE(@RefundDescricao, GatewayRefundDescricao),
            GatewayRefundReceiptUrl = COALESCE(@RefundReceiptUrl, GatewayRefundReceiptUrl),
            GatewayRefundConfirmadoEm = COALESCE(GatewayRefundConfirmadoEm, SYSDATETIME()),
            GatewayUltimoEvento = COALESCE(@Evento, GatewayUltimoEvento),
            GatewayErroMensagem = NULL,
            GatewayAtualizadoEm = SYSDATETIME()
        WHERE Id = @TransacaoId
          AND LTRIM(RTRIM(ISNULL(Status, N''))) IN (N'Pago', N'Reembolsado');

        UPDATE dbo.Consultas
        SET StatusPagamento = N'Reembolsado'
        WHERE Id = @ConsultaId
          AND LTRIM(RTRIM(ISNULL(StatusPagamento, N''))) <> N'Reembolsado';

        IF OBJECT_ID('dbo.LogsFinanceiros', 'U') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.LogsFinanceiros WITH (READCOMMITTEDLOCK)
            WHERE TransacaoId = @TransacaoId
              AND LTRIM(RTRIM(ISNULL(Acao, N''))) = N'Estorno'
              AND Observacao LIKE N'Estorno Asaas confirmado%'
          )
        BEGIN
          INSERT INTO dbo.LogsFinanceiros (TransacaoId, RepasseId, Usuario, Acao, DataAcao, Observacao)
          VALUES (@TransacaoId, NULL, N'Sistema', N'Estorno', SYSDATETIME(), @Observacao);
        END

        COMMIT;

        SELECT
          @TransacaoId AS TransacaoId,
          @ConsultaId AS ConsultaId,
          CAST(1 AS bit) AS ReembolsoConfirmado,
          N'Reembolsado' AS Status;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH
    `);

    return result?.recordset?.[0] ?? { TransacaoId: id, ReembolsoConfirmado: true };
  },

  async solicitarReembolsoAsaas({ transacaoId, valor = null, motivo = null } = {}, usuario) {
    const ctx = safeUsuario(usuario);
    if (!ctx?.id || !ctx?.tipo) {
      throw new HttpError(401, 'Não autenticado.');
    }
    if (!['Admin', 'Paciente'].includes(ctx.tipo)) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const row = await this.buscarTransacaoGatewayParaReembolso(transacaoId, ctx);
    const status = normText(row.Status);
    const metodo = normText(row.MetodoPagamento);
    const refundStatus = normText(row.GatewayRefundStatus).toUpperCase();
    const valorTotal = moneyOrNull(row.ValorTotal);

    if (status === 'Reembolsado' && refundStatus === 'DONE') {
      return {
        transacaoId: Number(row.TransacaoId),
        status: 'Reembolsado',
        gatewayRefundStatus: 'DONE',
        reembolsoConfirmado: true,
        mensagem: 'Transação já estava reembolsada no Asaas.'
      };
    }
    if (!['Pago', 'Reembolsado'].includes(status)) {
      throw new HttpError(409, `A transação precisa estar Pago para estornar no Asaas (status atual: ${status || 'N/A'}).`);
    }
    if (Number(row.PagamentoViaPlataforma ?? 0) !== 1 || normText(row.OrigemPagamento) !== 'Plataforma') {
      throw new HttpError(400, 'Reembolso Asaas indisponível para pagamento fora da plataforma.');
    }
    if (metodo === 'Pacote' || metodo === 'CreditoCarteira') {
      throw new HttpError(400, 'Reembolso Asaas indisponível para transação paga com pacote ou crédito em carteira.');
    }
    if (['PENDING', 'REQUESTED', 'IN_PROGRESS'].includes(refundStatus)) {
      throw new HttpError(409, 'Já existe uma solicitação de estorno Asaas em processamento para esta transação.');
    }

    const paymentId = await this.resolverPaymentIdAsaas(row, ctx);
    const valorSolicitado = moneyOrNull(valor);
    const refundPayload = {
      description: gatewayText(motivo || `Estorno FisioHelp da transação #${row.TransacaoId}`, 255),
    };

    if (valorSolicitado && valorTotal && valorSolicitado < valorTotal) {
      refundPayload.value = valorSolicitado;
    }

    let respostaAsaas;
    try {
      respostaAsaas = await asaasClient.estornarPagamento(paymentId, refundPayload);
    } catch (err) {
      await this.atualizarGatewayReembolsoAsaas({
        transacaoId: row.TransacaoId,
        paymentId,
        refundInfo: {
          status: 'REQUEST_FAILED',
          value: valorSolicitado ?? valorTotal,
          description: refundPayload.description,
        },
        event: 'ASAAS_REFUND_REQUEST_FAILED',
        erroMensagem: err?.message ?? 'Falha ao solicitar estorno Asaas',
      }, ctx).catch(() => {});

      throw err;
    }

    const refundInfo = extractRefundInfo({
      response: respostaAsaas,
      fallbackValue: valorSolicitado ?? valorTotal,
      fallbackDescription: refundPayload.description,
    });
    const paymentStatus = getAsaasPaymentStatus(respostaAsaas);

    await this.atualizarGatewayReembolsoAsaas({
      transacaoId: row.TransacaoId,
      paymentId,
      paymentStatus,
      refundInfo,
      event: 'ASAAS_REFUND_REQUESTED',
      solicitado: true,
    }, ctx);

    if (isRefundFinal(null, refundInfo) && !isRefundPartial(null, refundInfo)) {
      await this.aplicarReembolsoAsaasConfirmado({
        transacaoId: row.TransacaoId,
        paymentId,
        paymentStatus,
        refundInfo,
        event: 'ASAAS_REFUND_REQUESTED_DONE',
      }, ctx);
    }

    return {
      transacaoId: Number(row.TransacaoId),
      consultaId: Number(row.ConsultaId),
      paymentId,
      gatewayRefundStatus: refundInfo.status,
      gatewayRefundValor: refundInfo.value ?? valorSolicitado ?? valorTotal,
      reembolsoConfirmado: isRefundFinal(null, refundInfo) && !isRefundPartial(null, refundInfo),
      respostaAsaas,
    };
  },

  async processarWebhookReembolsoAsaas({ transacaoId, payment = null, event = null, additionalInfo = null } = {}, usuario) {
    const ctx = safeUsuario(usuario) ?? usuario;
    const id = Number(transacaoId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, 'TransacaoId inválido.');
    }

    const paymentId = getAsaasPaymentId(payment);
    const paymentStatus = getAsaasPaymentStatus(payment);
    const refundInfo = extractRefundInfo({ payment, event });

    if (isRefundPartial(event, refundInfo)) {
      return this.atualizarGatewayReembolsoAsaas({
        transacaoId: id,
        paymentId,
        paymentStatus,
        refundInfo: { ...refundInfo, status: 'PARTIAL' },
        event,
        confirmado: false,
      }, ctx);
    }

    if (String(event ?? '').trim().toUpperCase() === 'PAYMENT_REFUND_DENIED') {
      const denialReason = denialReasonFromAdditionalInfo(additionalInfo);
      return this.atualizarGatewayReembolsoAsaas({
        transacaoId: id,
        paymentId,
        paymentStatus,
        refundInfo: { ...refundInfo, status: 'DENIED' },
        event,
        erroMensagem: denialReason ?? refundInfo?.description ?? 'Estorno negado pelo Asaas.',
        restaurarConsultaCancelada: true,
      }, ctx);
    }

    if (isRefundFinal(event, refundInfo)) {
      return this.aplicarReembolsoAsaasConfirmado({
        transacaoId: id,
        paymentId,
        paymentStatus,
        refundInfo: { ...refundInfo, status: refundInfo.status || 'DONE' },
        event,
      }, ctx);
    }

    return this.atualizarGatewayReembolsoAsaas({
      transacaoId: id,
      paymentId,
      paymentStatus,
      refundInfo: { ...refundInfo, status: refundInfo.status || 'PENDING' },
      event,
      solicitado: true,
    }, ctx);
  },

  async abandonarCheckoutPendente({ consultaId = null, transacaoId = null, motivo = null } = {}, usuario) {
    const ctx = safeUsuario(usuario);
    if (!ctx?.id || !ctx.tipo) {
      throw new HttpError(401, 'Não autenticado.');
    }

    const isPaciente = ctx.tipo === 'Paciente';
    const isAdmin = ctx.tipo === 'Admin';
    if (!isPaciente && !isAdmin) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const idConsulta = Number(consultaId ?? 0) || null;
    const idTransacao = Number(transacaoId ?? 0) || null;
    if (!idConsulta && !idTransacao) {
      throw new HttpError(400, 'consultaId ou transacaoId é obrigatório.');
    }

    const resultado = await queryWithContext(ctx, (req) => {
      req.input('ConsultaId', sql.Int, idConsulta);
      req.input('TransacaoId', sql.Int, idTransacao);
      req.input('PacienteId', sql.Int, isPaciente ? Number(ctx.id) : null);
      req.input('Motivo', sql.NVarChar(400), motivo || 'Checkout fechado antes da confirmação do pagamento.');
    }, `
      SET NOCOUNT ON;
      SET XACT_ABORT ON;

      BEGIN TRY
        BEGIN TRAN;

        DECLARE
          @ConsultaEfetiva INT = @ConsultaId,
          @TransacaoEfetiva INT = @TransacaoId,
          @PacienteEfetivo INT = @PacienteId,
          @StatusTransacao NVARCHAR(20) = NULL,
          @CancelouConsulta BIT = 0,
          @CancelouTransacao BIT = 0,
          @Mensagem NVARCHAR(300) = NULL;

        IF @TransacaoEfetiva IS NULL AND @ConsultaEfetiva IS NOT NULL
        BEGIN
          SELECT TOP (1)
            @TransacaoEfetiva = t.Id
          FROM dbo.Transacoes t WITH (UPDLOCK, HOLDLOCK)
          WHERE t.ConsultaId = @ConsultaEfetiva
            AND (@PacienteEfetivo IS NULL OR t.PacienteId = @PacienteEfetivo)
            AND t.Status IN (N'Pendente', N'Cancelado', N'Pago')
          ORDER BY
            CASE t.Status
              WHEN N'Pendente' THEN 0
              WHEN N'Pago' THEN 1
              ELSE 2
            END,
            t.Id DESC;
        END

        IF @TransacaoEfetiva IS NOT NULL
        BEGIN
          SELECT
            @ConsultaEfetiva = COALESCE(@ConsultaEfetiva, t.ConsultaId),
            @PacienteEfetivo = COALESCE(@PacienteEfetivo, t.PacienteId),
            @StatusTransacao = t.Status
          FROM dbo.Transacoes t WITH (UPDLOCK, HOLDLOCK)
          WHERE t.Id = @TransacaoEfetiva;
        END

        IF @ConsultaEfetiva IS NULL
        BEGIN
          THROW 51010, 'Checkout pendente não encontrado.', 1;
        END

        IF @PacienteId IS NOT NULL AND @PacienteEfetivo <> @PacienteId
        BEGIN
          THROW 51011, 'Checkout não pertence ao paciente autenticado.', 1;
        END

        IF @StatusTransacao = N'Pago'
        BEGIN
          SET @Mensagem = N'Pagamento já confirmado. Consulta não foi cancelada.';
        END
        ELSE
        BEGIN
          UPDATE dbo.Transacoes
          SET Status = N'Cancelado'
          WHERE ConsultaId = @ConsultaEfetiva
            AND PacienteId = @PacienteEfetivo
            AND Status = N'Pendente';

          IF @@ROWCOUNT > 0 SET @CancelouTransacao = 1;

          UPDATE dbo.Consultas
          SET Status = N'Cancelada',
              MotivoEncerramento = COALESCE(NULLIF(@Motivo, N''), MotivoEncerramento, N'Checkout fechado antes da confirmação do pagamento.'),
              DataEncerramento = COALESCE(DataEncerramento, SYSDATETIME()),
              ChatLiberado = 0
          WHERE Id = @ConsultaEfetiva
            AND PacienteId = @PacienteEfetivo
            AND Status IN (N'Aguardando', N'Confirmada')
            AND LTRIM(RTRIM(ISNULL(StatusPagamento, N''))) = N'Pendente'
            AND ISNULL(PagamentoViaPlataforma, 0) = 1
            AND LTRIM(RTRIM(ISNULL(OrigemPagamento, N''))) = N'Plataforma';

          IF @@ROWCOUNT > 0
          BEGIN
            SET @CancelouConsulta = 1;
            SET @Mensagem = N'Checkout abandonado. Consulta cancelada e horário liberado.';
          END
          ELSE IF @CancelouTransacao = 1
          BEGIN
            SET @Mensagem = N'Transação pendente cancelada. Consulta não estava elegível para cancelamento automático.';
          END
          ELSE
          BEGIN
            SET @Mensagem = N'Nenhum checkout pendente elegível para cancelamento.';
          END
        END

        COMMIT;

        SELECT
          @ConsultaEfetiva AS ConsultaId,
          @TransacaoEfetiva AS TransacaoId,
          @CancelouConsulta AS ConsultaCancelada,
          @CancelouTransacao AS TransacaoCancelada,
          @Mensagem AS Mensagem;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        DECLARE @Err NVARCHAR(4000) = ERROR_MESSAGE();
        RAISERROR(@Err, 16, 1);
      END CATCH
    `);

    const row = resultado?.recordset?.[0] ?? {};
    return {
      ConsultaId: Number(row.ConsultaId ?? consultaId ?? 0) || null,
      TransacaoId: Number(row.TransacaoId ?? transacaoId ?? 0) || null,
      ConsultaCancelada: row.ConsultaCancelada === true || row.ConsultaCancelada === 1,
      TransacaoCancelada: row.TransacaoCancelada === true || row.TransacaoCancelada === 1,
      Mensagem: row.Mensagem ?? 'Checkout abandonado.'
    };
  },
  
/**
   * iniciarPagamentoPacote (stand-by)
   * - Simula um pagamento de pacote (para dev/testes)
   * - Em produção, isso vira uma integração real com o gateway
   */
  async iniciarPagamentoPacote(params = {}) {
    const {
      pacienteId,
      fisioterapeutaId,
      quantidadeConsultas,
      valorTotal,
      statusSimulado
    } = params;

    const status = (statusSimulado ?? 'Pendente').toString();

    // Id "fake" para simular retorno do gateway (formato compatível com o que você já grava hoje)
    const paymentId = `PKT_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

    return {
      gateway: 'StandBy',
      paymentId,
      status,
      valorPago: status === 'Pago' ? Number(valorTotal) : null,
      pacienteId: Number(pacienteId) || null,
      fisioterapeutaId: Number(fisioterapeutaId) || null,
      quantidadeConsultas: Number(quantidadeConsultas) || null
    };
  },

  /**
   * reembolsarPagamentoPacote (stand-by)
   * - Simula reembolso/estorno do pagamento de um pacote.
   */
  async reembolsarPagamentoPacote(params = {}) {
    const {
      gateway = 'StandBy',
      gatewayPaymentId = null,
      pacoteId = null,
      pacienteId = null,
      valor = 0,
      motivo = null,
      statusSimulado = null,
    } = params;

    const status = String(statusSimulado ?? 'Estornado');

    return {
      ok: true,
      gateway,
      paymentId: gatewayPaymentId,
      status,
      valor: Number(valor ?? 0),
      pacoteId,
      pacienteId,
      motivo,
      processedAt: new Date().toISOString(),
    };
  }
};
  

export default pagamentosGatewayService;
