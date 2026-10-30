import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertOperationEnabled,
  createOperationDisabledError,
  getOperationStatus,
  isOperationEnabled,
  readRuntimeFlag,
} from '../utils/operationStatus.js';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('flags operacionais preservam o comportamento atual quando ausentes', () => {
  assert.equal(isOperationEnabled('cadastro', {}), true);
  assert.equal(isOperationEnabled('agendamento', {}), true);
  assert.equal(isOperationEnabled('contratacao', {}), true);
});

test('flags são lidas em cada chamada e configuração inválida falha fechada', () => {
  const env = { NOVOS_CADASTROS_ENABLED: 'true' };
  assert.equal(isOperationEnabled('cadastro', env), true);

  env.NOVOS_CADASTROS_ENABLED = 'false';
  assert.equal(isOperationEnabled('cadastro', env), false);
  assert.equal(readRuntimeFlag('FLAG', { FLAG: 'valor-invalido' }), false);
});

test('erro de encerramento expõe HTTP 403 e código estável', () => {
  const error = createOperationDisabledError('contratacao');
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'NOVAS_CONTRATACOES_ENCERRADAS');
  assert.match(error.message, /pagamentos não estão mais disponíveis/i);

  assert.throws(
    () => assertOperationEnabled('agendamento', { NOVOS_AGENDAMENTOS_ENABLED: 'false' }),
    (caught) => caught?.statusCode === 403 && caught?.code === 'NOVOS_AGENDAMENTOS_ENCERRADOS'
  );
});

test('endpoint operacional retorna datas e estados sem cache de módulo', () => {
  const status = getOperationStatus({
    NOVOS_CADASTROS_ENABLED: 'false',
    NOVOS_AGENDAMENTOS_ENABLED: 'true',
    NOVAS_CONTRATACOES_ENABLED: 'false',
    PLATFORM_CLOSING_DATE: '2026-11-30',
    PLATFORM_SUPPORT_END_DATE: '2026-12-30',
  });

  assert.deepEqual(status, {
    novosCadastros: false,
    novosAgendamentos: true,
    novasContratacoes: false,
    encerramentoEm: '2026-11-30',
    suporteAte: '2026-12-30',
  });
});

test('rotas bloqueiam cadastro novo sem tocar verificação de contato existente', () => {
  const cadastroRoutes = read('../routes/cadastro.js');
  const pacienteRoutes = read('../routes/pacientes.js');
  const fisioRoutes = read('../routes/fisioterapeutas.js');
  const authRoutes = read('../routes/auth.js');

  assert.match(cadastroRoutes, /router\.use\(requireNewRegistrationsEnabled\)/);
  assert.match(pacienteRoutes, /router\.post\('\/social', requireTrustedBff, requireNewRegistrationsEnabled/);
  assert.match(pacienteRoutes, /router\.post\('\/ativar-pre-cadastro', requireNewRegistrationsEnabled/);
  assert.match(authRoutes, /'\/oauth\/cadastro-token',[\s\S]*requireNewRegistrationsEnabled/);
  assert.match(fisioRoutes, /'\/pacientes\/pre-cadastro',[\s\S]*requireNewRegistrationsEnabled/);

  const existingPatientContact = pacienteRoutes.slice(
    pacienteRoutes.indexOf("router.post('/:id/contato/solicitar'"),
    pacienteRoutes.indexOf("router.get('/:id'", pacienteRoutes.indexOf("router.post('/:id/contato/solicitar'"))
  );
  assert.doesNotMatch(existingPatientContact, /requireNewRegistrationsEnabled/);
});

test('webhooks, abandono e reembolso ficam fora do bloqueio de contratação', () => {
  const routes = read('../routes/pagamentosGateway.js');

  for (const path of [
    '/webhook/standby',
    '/webhook/asaas',
    '/webhook/asaas/saque-autorizacao',
    '/checkout/:consultaId/abandonar',
    '/pacotes/checkout/:pacoteId/abandonar',
    '/transacoes/:transacaoId/reembolsar-asaas',
  ]) {
    const start = routes.indexOf(`'${path}'`);
    assert.ok(start >= 0, `Rota ausente: ${path}`);
    const end = routes.indexOf(');', start);
    assert.doesNotMatch(routes.slice(start, end), /requireNewContractsEnabled/);
  }

  for (const path of ['/checkout', '/pacotes/checkout', '/confirmar-transacao']) {
    const start = routes.indexOf(`'${path}'`);
    assert.ok(start >= 0, `Rota ausente: ${path}`);
    const end = routes.indexOf(');', start);
    assert.match(routes.slice(start, end), /requireNewContractsEnabled/);
  }
});

test('reagendamento de no-show é bloqueado sem impedir crédito ou reembolso', () => {
  const service = read('../services/consultasService.js');
  const start = service.indexOf('async decidirNoShowFisio(');
  const end = service.indexOf('async opcoesPagamento(', start);
  const block = service.slice(start, end);

  assert.match(block, /if \(opcao === 'Reagendar'\) \{\s*assertOperationEnabled\('agendamento'\)/);
  assert.doesNotMatch(block, /if \(opcao === 'Reembolso'\) \{\s*assertOperationEnabled/);
  assert.doesNotMatch(block, /if \(opcao === 'Credito'\) \{\s*assertOperationEnabled/);
});

