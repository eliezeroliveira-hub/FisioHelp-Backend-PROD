//routes/pagamentosGateway.js

import express from 'express';
import pagamentosGatewayController from '../controllers/pagamentosGatewayController.js';
import { autenticarJWT, requireAuth } from '../middleware/authJWT.js';
import { pagamentosWebhookLimiter } from '../middleware/apiLimiter.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

//  Stand-by: webhook “sem JWT” (usa secret no header)
// Header: x-gateway-secret: <seu secret>
router.post('/webhook/standby',
  pagamentosWebhookLimiter,
  pagamentosGatewayController.webhookStandBy
);

// Asaas: webhook real do checkout hospedado (sem JWT; valida token no header asaas-access-token)
router.post('/webhook/asaas',
  pagamentosWebhookLimiter,
  pagamentosGatewayController.webhookAsaas
);

// Asaas: validação de saque/transferência via webhook de segurança (responde APPROVED/REFUSED)
router.post('/webhook/asaas/saque-autorizacao',
  pagamentosWebhookLimiter,
  pagamentosGatewayController.webhookAsaasSaqueAutorizacao
);

// Asaas: cria checkout hospedado para uma consulta pendente do paciente logado
router.post('/checkout',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Paciente']),
  pagamentosGatewayController.criarCheckout
);

// Asaas: cria checkout hospedado para compra de pacote pendente
router.post('/pacotes/checkout',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Paciente']),
  pagamentosGatewayController.criarCheckoutPacote
);

// Asaas: abandona um checkout ainda pendente e libera o horário da consulta
router.post('/checkout/:consultaId/abandonar',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Paciente']),
  pagamentosGatewayController.abandonarCheckout
);

// Asaas: abandona um checkout de pacote ainda pendente
router.post('/pacotes/checkout/:pacoteId/abandonar',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Paciente']),
  pagamentosGatewayController.abandonarCheckoutPacote
);

// Asaas: enfileira estorno de uma transação já paga para processamento automático
router.post('/transacoes/:transacaoId/reembolsar-asaas',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Admin']),
  pagamentosGatewayController.solicitarReembolsoAsaas
);

//  Stand-by: rota manual (Admin) para simular confirmação de pagamento
router.post('/confirmar-transacao',
  autenticarJWT,
  requireAuth,
  verificarPermissao(['Admin']),
  pagamentosGatewayController.confirmarTransacaoPaga
);


export default router;
