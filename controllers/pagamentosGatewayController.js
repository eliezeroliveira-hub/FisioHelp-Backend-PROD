//  controllers/pagamentosGatewayController.js

import crypto from 'crypto';
import pagamentosGatewayService from '../services/pagamentosGatewayService.js';
import reembolsosGatewayFilaService from '../services/reembolsosGatewayFilaService.js';
import repassesGatewayService from '../services/repassesGatewayService.js';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';

function secretsMatch(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;

  const bufReceived = Buffer.from(received, 'utf8');
  const bufExpected = Buffer.from(expected, 'utf8');

  if (bufReceived.length !== bufExpected.length) return false;
  return crypto.timingSafeEqual(bufReceived, bufExpected);
}

function resolveAsaasBillingType(payment, checkout) {
  if (payment?.billingType) return payment.billingType;
  if (checkout?.billingType) return checkout.billingType;
  if (Array.isArray(checkout?.billingTypes) && checkout.billingTypes.length === 1) {
    return checkout.billingTypes[0];
  }
  return null;
}

function resolveAsaasPaymentId(payment) {
  return payment?.id ?? payment?.paymentId ?? payment?.payment_id ?? null;
}

function resolveAsaasInstallmentId(payment) {
  const installment = payment?.installment;
  return (
    (installment && typeof installment === 'object' ? installment.id : installment) ??
    payment?.installmentId ??
    payment?.installment_id ??
    null
  );
}

function resolveAsaasCheckoutId(payment, checkout) {
  return (
    checkout?.id ??
    payment?.checkoutSession ??
    payment?.checkout ??
    payment?.checkoutId ??
    payment?.checkout_id ??
    null
  );
}

function resolveAsaasExternalReference(payment, checkout) {
  return payment?.externalReference ?? checkout?.externalReference ?? null;
}

function resolvePacoteExternalReference(value) {
  const match = String(value ?? '').trim().match(/^PACOTE_(\d+)$/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const pagamentosGatewayController = {
  async criarCheckout(req, res) {
    try {
      const resultado = await pagamentosGatewayService.criarCheckoutAsaas(
        {
          consultaId: req.body?.consultaId ?? req.body?.ConsultaId,
          billingType: req.body?.billingType ?? req.body?.BillingType,
        },
        req.usuario
      );

      return res.json({ sucesso: true, ...resultado });
    } catch (erro) {
      const status = erro?.statusCode || erro?.status || 500;
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro interno do servidor.' : erro.message
      });
    }
  },

  async criarCheckoutPacote(req, res) {
    try {
      const resultado = await pagamentosGatewayService.criarCheckoutPacoteAsaas(
        {
          pacoteId: req.body?.pacoteId ?? req.body?.PacoteId,
          billingType: req.body?.billingType ?? req.body?.BillingType,
        },
        req.usuario
      );

      return res.json({ sucesso: true, ...resultado });
    } catch (erro) {
      const status = erro?.statusCode || erro?.status || 500;
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro interno do servidor.' : erro.message
      });
    }
  },

  async abandonarCheckout(req, res) {
    try {
      const resultado = await pagamentosGatewayService.abandonarCheckoutPendente(
        {
          consultaId: req.params?.consultaId ?? req.body?.consultaId ?? req.body?.ConsultaId,
          motivo: req.body?.Motivo ?? req.body?.motivo ?? 'Checkout fechado antes da confirmação do pagamento.',
        },
        req.usuario
      );

      return res.json({ sucesso: true, ...resultado });
    } catch (erro) {
      const status = erro?.statusCode || erro?.status || 500;
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro interno do servidor.' : erro.message
      });
    }
  },

  async abandonarCheckoutPacote(req, res) {
    try {
      const resultado = await pagamentosGatewayService.cancelarCheckoutPacotePendente(
        {
          pacoteId: req.params?.pacoteId ?? req.body?.pacoteId ?? req.body?.PacoteId,
          motivo: req.body?.Motivo ?? req.body?.motivo ?? 'Checkout de pacote fechado antes da confirmação do pagamento.',
        },
        req.usuario
      );

      return res.json({ sucesso: true, ...resultado });
    } catch (erro) {
      const status = erro?.statusCode || erro?.status || 500;
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro interno do servidor.' : erro.message
      });
    }
  },

  async solicitarReembolsoAsaas(req, res) {
    try {
      const resultado = await reembolsosGatewayFilaService.enfileirarReembolso(
        {
          transacaoId: req.params?.transacaoId ?? req.body?.transacaoId ?? req.body?.TransacaoId,
          valor: req.body?.valor ?? req.body?.Valor ?? null,
          motivo: req.body?.motivo ?? req.body?.Motivo ?? null,
          origem: 'Admin',
        },
        req.usuario
      );

      return res.json({
        sucesso: true,
        mensagem: 'Reembolso enfileirado para processamento automático.',
        fila: resultado
      });
    } catch (erro) {
      const status = erro?.statusCode || erro?.status || 500;
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro interno do servidor.' : erro.message
      });
    }
  },

  //  Stand-by (manual): Admin chama no Postman simulando "webhook"
  async confirmarTransacaoPaga(req, res) {
    try {
      const transacaoId = req.body?.TransacaoId ?? req.body?.transacaoId ?? req.params?.transacaoId ?? null;

      const resultado = await pagamentosGatewayService.confirmarTransacaoPaga(transacaoId, req.usuario);

      return res.json({ sucesso: true, ...((resultado || {})) });
    } catch (erro) {
      const status = erro?.statusCode || 500;
      return res.status(status).json({ sucesso: false, erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  // Webhook stand-by (sem JWT): valida segredo e confirma a transação
  async webhookStandBy(req, res) {
    try {
      const receivedSecret = req.headers['x-gateway-secret'] ?? null;
      const expectedSecret = ENV.GATEWAY_WEBHOOK_SECRET ?? null;

      if (!expectedSecret) {
        return res.status(500).json({ sucesso: false, erro: 'GATEWAY_WEBHOOK_SECRET não configurado.' });
      }
      if (!receivedSecret || !secretsMatch(String(receivedSecret), String(expectedSecret))) {
        return res.status(401).json({ sucesso: false, erro: 'Webhook não autorizado.' });
      }

      const transacaoId =
        req.body?.TransacaoId ??
        req.body?.transacaoId ??
        req.body?.data?.TransacaoId ??
        req.body?.data?.transacaoId ??
        req.params?.transacaoId ??
        null;

      const resultado = await pagamentosGatewayService.confirmarTransacaoPagaStandBy(transacaoId);

      return res.json({ sucesso: true, ...((resultado || {})) });
    } catch (erro) {
      const status = erro?.statusCode || 500;
      return res.status(status).json({ sucesso: false, erro: status >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  async webhookAsaas(req, res) {
    try {
      const receivedToken = req.headers['asaas-access-token'] ?? null;
      const expectedToken = ENV.ASAAS_WEBHOOK_TOKEN ?? null;

      if (!expectedToken) {
        return res.status(500).json({ sucesso: false, erro: 'ASAAS_WEBHOOK_TOKEN não configurado.' });
      }
      if (!receivedToken || !secretsMatch(String(receivedToken), String(expectedToken))) {
        return res.status(401).json({ sucesso: false, erro: 'Webhook não autorizado.' });
      }

      const event = req.body?.event;
      const payment = req.body?.payment ?? null;
      const checkout = req.body?.checkout ?? null;
      const transfer = req.body?.transfer ?? req.body?.data?.transfer ?? null;
      const usuarioSistema = { tipo: 'Admin', id: ENV.SYSTEM_ADMIN_ID };

      if (String(event ?? '').startsWith('TRANSFER_')) {
        await repassesGatewayService.processarWebhookTransferenciaAsaas({
          event,
          transfer,
          body: req.body,
        }, usuarioSistema);

        return res.json({ received: true });
      }

      const entity = payment ?? checkout ?? {};
      const checkoutId = resolveAsaasCheckoutId(payment, checkout);
      const paymentId = resolveAsaasPaymentId(payment);
      const installmentId = resolveAsaasInstallmentId(payment);
      const externalReference = resolveAsaasExternalReference(payment, checkout);

      let pacoteId = resolvePacoteExternalReference(externalReference ?? entity?.externalReference);
      let transacaoId = pacoteId ? 0 : Number(externalReference ?? entity?.externalReference);

      if ((!Number.isFinite(transacaoId) || transacaoId <= 0) && (checkoutId || paymentId)) {
        const mappedId = await pagamentosGatewayService.buscarTransacaoIdPorGatewayReferencia(
          { checkoutId, paymentId, externalReference },
          usuarioSistema
        );
        transacaoId = Number(mappedId ?? 0);
      }
      if ((!Number.isFinite(pacoteId) || pacoteId <= 0) && (checkoutId || paymentId || externalReference)) {
        const mappedPacoteId = await pagamentosGatewayService.buscarPacoteIdPorGatewayReferencia(
          { checkoutId, paymentId, installmentId, externalReference },
          usuarioSistema
        );
        pacoteId = Number(mappedPacoteId ?? 0);
      }

      const billingType = resolveAsaasBillingType(payment, checkout);
      const eventosPagos = new Set(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'CHECKOUT_PAID']);
      const eventosCancelados = new Set([
        'PAYMENT_OVERDUE',
        'PAYMENT_DELETED',
        'CHECKOUT_CANCELED',
        'CHECKOUT_EXPIRED'
      ]);
      const eventosReembolso = new Set([
        'PAYMENT_REFUND_IN_PROGRESS',
        'PAYMENT_REFUNDED',
        'PAYMENT_PARTIALLY_REFUNDED',
        'PAYMENT_REFUND_DENIED'
      ]);

      log('info', 'Webhook Asaas recebido', {
        event,
        transacaoId: transacaoId > 0 ? transacaoId : null,
        pacoteId: pacoteId > 0 ? pacoteId : null,
        checkoutId: checkoutId ?? null,
        paymentId: paymentId ?? null,
        installmentId: installmentId ?? null,
        hasPayment: Boolean(payment),
        hasCheckout: Boolean(checkout)
      });

      if (transacaoId > 0) {
        await pagamentosGatewayService.registrarReferenciaGatewayAsaas({
          transacaoId,
          checkoutId,
          paymentId,
          paymentStatus: payment?.status ?? checkout?.status ?? null,
          event,
        }, usuarioSistema);
      }
      if (pacoteId > 0) {
        await pagamentosGatewayService.registrarReferenciaGatewayPacoteAsaas({
          pacoteId,
          checkoutId,
          paymentId,
          installmentId,
          paymentStatus: payment?.status ?? checkout?.status ?? null,
          event,
        }, usuarioSistema);
      }

      if (eventosPagos.has(event) && pacoteId > 0) {
        await pagamentosGatewayService.confirmarPagamentoPacoteAsaas(
          pacoteId,
          billingType,
          usuarioSistema,
          { netValue: payment?.netValue ?? null }
        );
        if (!paymentId || !installmentId) {
          await pagamentosGatewayService.resolverPaymentIdAsaasPacote({
            PacoteId: pacoteId,
            GatewayCheckoutId: checkoutId,
            GatewayPaymentId: paymentId,
            GatewayInstallmentId: installmentId,
          }, usuarioSistema).catch((erro) => {
            log('warn', 'Pagamento Asaas de pacote ainda sem identificador conciliável', {
              pacoteId,
              checkoutId: checkoutId ?? null,
              erro: erro?.message,
            });
          });
        }
      } else if (eventosCancelados.has(event) && pacoteId > 0) {
        await pagamentosGatewayService.cancelarCheckoutPacotePendente(
          {
            pacoteId,
            motivo: event === 'CHECKOUT_EXPIRED'
              ? 'Checkout Asaas de pacote expirado antes da confirmação do pagamento.'
              : 'Checkout Asaas de pacote cancelado antes da confirmação do pagamento.'
          },
          usuarioSistema
        );
      } else if (eventosPagos.has(event) && transacaoId > 0) {
        await pagamentosGatewayService.confirmarPagamentoAsaas(
          transacaoId,
          billingType,
          usuarioSistema,
          { netValue: payment?.netValue ?? null }
        );
        if (!paymentId) {
          await pagamentosGatewayService.resolverPaymentIdAsaas({
            TransacaoId: transacaoId,
            GatewayCheckoutId: checkoutId,
          }, usuarioSistema).catch((erro) => {
            log('warn', 'Pagamento Asaas de consulta ainda sem payment.id conciliável', {
              transacaoId,
              checkoutId: checkoutId ?? null,
              erro: erro?.message,
            });
          });
        }
      } else if (eventosCancelados.has(event) && transacaoId > 0) {
        await pagamentosGatewayService.abandonarCheckoutPendente(
          {
            transacaoId,
            motivo: event === 'CHECKOUT_EXPIRED'
              ? 'Checkout Asaas expirado antes da confirmação do pagamento.'
            : 'Checkout Asaas cancelado antes da confirmação do pagamento.'
          },
          usuarioSistema
        );
      } else if (eventosReembolso.has(event) && pacoteId > 0) {
        await pagamentosGatewayService.processarWebhookReembolsoPacoteAsaas({
          pacoteId,
          payment,
          event,
          additionalInfo: req.body?.additionalInfo ?? null,
        }, usuarioSistema);
        await reembolsosGatewayFilaService.atualizarPorWebhook({
          pacoteId,
          payment,
          event,
          additionalInfo: req.body?.additionalInfo ?? null,
        }, usuarioSistema);
      } else if (eventosReembolso.has(event) && transacaoId > 0) {
        await pagamentosGatewayService.processarWebhookReembolsoAsaas({
          transacaoId,
          payment,
          event,
          additionalInfo: req.body?.additionalInfo ?? null,
        }, usuarioSistema);
        await reembolsosGatewayFilaService.atualizarPorWebhook({
          transacaoId,
          payment,
          event,
          additionalInfo: req.body?.additionalInfo ?? null,
        }, usuarioSistema);
      } else if ((eventosPagos.has(event) || eventosCancelados.has(event)) && !(transacaoId > 0) && !(pacoteId > 0)) {
        log('warn', 'Webhook Asaas sem TransacaoId/PacoteId mapeavel', { event, checkoutId: checkoutId ?? null });
      } else if (eventosReembolso.has(event) && !(transacaoId > 0)) {
        log('warn', 'Webhook Asaas de reembolso sem TransacaoId mapeavel', {
          event,
          checkoutId: checkoutId ?? null,
          paymentId: paymentId ?? null
        });
      }

      return res.json({ received: true });
    } catch (erro) {
      log('error', 'Erro no webhook Asaas', { erro: erro?.message });
      return res.status(200).json({ received: true });
    }
  },

  async webhookAsaasSaqueAutorizacao(req, res) {
    try {
      const receivedToken = req.headers['asaas-access-token'] ?? null;
      const expectedToken = ENV.ASAAS_WITHDRAWAL_WEBHOOK_TOKEN ?? ENV.ASAAS_WEBHOOK_TOKEN ?? null;

      if (!expectedToken) {
        return res.status(500).json({ status: 'REFUSED', refuseReason: 'Token de autorização não configurado.' });
      }
      if (!receivedToken || !secretsMatch(String(receivedToken), String(expectedToken))) {
        return res.status(401).json({ status: 'REFUSED', refuseReason: 'Webhook não autorizado.' });
      }

      const usuarioSistema = { tipo: 'Admin', id: ENV.SYSTEM_ADMIN_ID };
      const pixRefundAutorizacao = await reembolsosGatewayFilaService.validarSolicitacaoPixRefundAsaas({
        body: req.body,
      }, usuarioSistema);
      if (pixRefundAutorizacao) {
        return res.json(pixRefundAutorizacao);
      }

      const resultado = await repassesGatewayService.validarSolicitacaoSaqueAsaas({
        transfer: req.body?.transfer ?? null,
        body: req.body,
      }, usuarioSistema);

      return res.json(resultado);
    } catch (erro) {
      log('error', 'Erro na autorização de saque Asaas', { erro: erro?.message });
      return res.status(200).json({
        status: 'REFUSED',
        refuseReason: 'Falha interna ao validar a solicitação de saque.',
      });
    }
  }
};

export default pagamentosGatewayController;


