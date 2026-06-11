//routes/pacotes.js
import express from 'express';
import pacotesController from '../controllers/pacotesController.js';
import { autenticarJWT } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';

const router = express.Router();

/**
 * Observação:
 * - Mantive autenticação aqui (igual outros routes), mesmo o routes/index também aplicando.
 * - Isso evita “rota desprotegida” caso alguém mova a montagem futuramente.
 */
router.use(autenticarJWT);

/**
 * GET /api/pacotes
 * Lista os pacotes do paciente logado.
 * Query: status=Ativo|PendentePagamento|..., limit, offset
 */
router.get('/', verificarPermissao(['Paciente']), pacotesController.listarMeus);

/**
 * POST /api/pacotes/pre-compra/resumo
 * Body: { FisioterapeutaId, EspecialidadeId?, QuantidadeConsultas }
 */
router.post('/pre-compra/resumo', verificarPermissao(['Paciente']), pacotesController.resumoPreCompra);

/**
 * POST /api/pacotes/comprar
 * Body: { FisioterapeutaId, QuantidadeConsultas, Nome?, GatewayStatusSimulado? }
 */
router.post('/comprar', verificarPermissao(['Paciente']), pacotesController.comprar);

/**
 * POST /api/pacotes/:id/confirmar-pagamento
 * Body: { Gateway?, GatewayPaymentId?, GatewayStatus?, ValorPago? }
 * - Fluxo do paciente. Confirmações administrativas/gateway devem usar rota própria.
 */
router.post('/:id/confirmar-pagamento', verificarPermissao(['Paciente']), pacotesController.confirmarPagamento);

/**
 * GET /api/pacotes/:id/opcoes-cancelamento
 */
router.get('/:id/opcoes-cancelamento', verificarPermissao(['Paciente']), pacotesController.opcoesCancelamento);

/**
 * POST /api/pacotes/:id/cancelar
 * Body: { opcaoReembolso: 'Reembolso' | 'Credito', motivo? }
 */
router.post('/:id/cancelar', verificarPermissao(['Paciente']), pacotesController.cancelar);

export default router;
