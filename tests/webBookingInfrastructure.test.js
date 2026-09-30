import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { trustedBffContext, requireTrustedBff } from '../middleware/trustedBff.js';
import { getClientIp } from '../utils/clientIp.js';

const source = (file) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

test('BFF só é confiável com segredo válido e repassa IP normalizado', () => {
  const previous = process.env.BFF_INTERNAL_SECRET;
  process.env.BFF_INTERNAL_SECRET = 'segredo-teste';
  const req = {
    get(name) {
      if (name === 'x-fisiohelp-internal-secret') return 'segredo-teste';
      if (name === 'x-fisiohelp-client-ip') return '203.0.113.7';
      return null;
    },
    ip: '10.0.0.5',
  };
  trustedBffContext(req, {}, () => undefined);
  assert.equal(req.isTrustedBff, true);
  assert.equal(getClientIp(req), '203.0.113.7');
  if (previous === undefined) delete process.env.BFF_INTERNAL_SECRET;
  else process.env.BFF_INTERNAL_SECRET = previous;
});

test('rota interna rejeita chamada direta e cadastro social exige o BFF', () => {
  let status = null;
  const res = {
    status(value) { status = value; return this; },
    json(value) { return value; },
  };
  requireTrustedBff({}, res, () => assert.fail('não deveria liberar'));
  assert.equal(status, 403);
  assert.match(source('routes/pacientes.js'), /router\.post\('\/social', requireTrustedBff, pacientesController\.criarSocial\)/);
});

test('canal web grava PacienteWeb e mantém PacienteApp como padrão', () => {
  const consultas = source('services/consultasService.js');
  assert.match(consultas, /CanalOrigem[\s\S]*=== 'web'[\s\S]*\? 'PacienteWeb'[\s\S]*: 'PacienteApp'/);
  assert.match(source('controllers/consultasController.js'), /payload\.canalOrigem[\s\S]*payload\.CanalOrigem/);
});

test('retomada web serializa a decisão e só ela ativa reutilização', () => {
  const gateway = source('services/pagamentosGatewayService.js');
  assert.match(gateway, /sp_getapplock/);
  assert.match(gateway, /CheckoutAsaasConsulta:/);
  assert.match(gateway, /reutilizarCheckoutAtivo === true[\s\S]*withCheckoutApplicationLock/);
  const controller = source('controllers/pagamentosGatewayController.js');
  assert.match(controller, /reutilizarCheckoutAtivo = req\.body\?\.reutilizarCheckoutAtivo === true/);
  assert.match(controller, /webOrigin: reutilizarCheckoutAtivo \? req\.get\('origin'\) : null/);
  assert.match(gateway, /resolveCheckoutCallback/);
  assert.match(gateway, /WEB_CHECKOUT_ALLOWED_ORIGINS/);
  assert.match(gateway, /reutilizarCheckoutAtivo !== true[\s\S]*ASAAS_SUCCESS_URL/);
  assert.match(gateway, /checkoutCallback = resolveCheckoutCallback[\s\S]*const transacaoResult/);
  assert.match(gateway, /COALESCE\(checkoutLog\.CheckoutCriadoEm, t\.DataCriacao\)/);
  assert.match(gateway, /Checkout Asaas criado:/);
  assert.match(gateway, /INSERT INTO dbo\.LogsFinanceiros/);
  assert.match(gateway, /N'Criação'/);
  assert.doesNotMatch(gateway, /N'Checkout'/);
  assert.match(gateway, /RegistrarCheckoutWeb[\s\S]*reutilizarCheckoutAtivo === true/);
  assert.match(gateway, /IF @RegistrarCheckoutWeb = 1/);
  assert.match(gateway, /IF @RegistrarCheckoutWeb = 1[\s\S]*BEGIN TRANSACTION/);
  assert.match(gateway, /COMMIT TRANSACTION/);
  assert.match(gateway, /ROLLBACK TRANSACTION/);
  assert.match(gateway, /reutilizarCheckoutAtivo === true \? \{ timeoutMs: ASAAS_WEB_CHECKOUT_TIMEOUT_MS \} : undefined/);
});

test('timeout do ACS protege também e-mails síncronos e OTP sem alterar o dispatcher do app', () => {
  const contato = source('providers/contatoProvider.js');
  const gateway = source('services/pagamentosGatewayService.js');
  assert.match(contato, /executarComAbortTimeout/);
  assert.match(contato, /beginSend\(message, \{ abortSignal \}\)/);
  assert.match(contato, /aguardarPollerAcs/);
  assert.doesNotMatch(contato, /await poller\.poll\(\)/);
  assert.match(gateway, /void notificacoesDispatch\.pagamentoConfirmadoConsulta/);
  assert.doesNotMatch(gateway, /await notificacoesDispatch\.pagamentoConfirmadoConsulta/);
});
