import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ESTADO_CREFITO_IMUTAVEL_MESSAGE,
  normalizeUf,
  validarJurisdicaoAtendimentoAtual,
} from '../utils/jurisdiction.js';

test('normalizeUf normaliza somente UFs com duas letras', () => {
  assert.equal(normalizeUf(' ba '), 'BA');
  assert.equal(normalizeUf('Bahia'), null);
  assert.equal(normalizeUf(null), null);
});

test('jurisdição permite paciente e fisioterapeuta verificado na mesma UF', () => {
  assert.deepEqual(
    validarJurisdicaoAtendimentoAtual({
      pacienteEstado: 'ba',
      fisioterapeutaEstado: 'BA',
      crefitoVerificado: 1,
    }),
    { estadoPaciente: 'BA', estadoFisio: 'BA' }
  );
});

test('jurisdição bloqueia CREFITO não verificado mesmo na mesma UF', () => {
  assert.throws(
    () => validarJurisdicaoAtendimentoAtual({
      pacienteEstado: 'BA',
      fisioterapeutaEstado: 'BA',
      crefitoVerificado: 0,
    }),
    (error) => error?.statusCode === 403 && /CREFITO pendente/.test(error.message)
  );
});

test('jurisdição bloqueia UFs diferentes', () => {
  assert.throws(
    () => validarJurisdicaoAtendimentoAtual({
      pacienteEstado: 'SP',
      fisioterapeutaEstado: 'BA',
      crefitoVerificado: true,
    }),
    (error) => error?.statusCode === 403 && /jurisdição diferente/.test(error.message)
  );
});

test('jurisdição falha fechada quando alguma UF está ausente ou inválida', () => {
  for (const input of [
    { pacienteEstado: null, fisioterapeutaEstado: 'BA' },
    { pacienteEstado: 'BA', fisioterapeutaEstado: null },
    { pacienteEstado: 'Bahia', fisioterapeutaEstado: 'BA' },
  ]) {
    assert.throws(
      () => validarJurisdicaoAtendimentoAtual({ ...input, crefitoVerificado: 1 }),
      (error) => error?.statusCode === 403
    );
  }
});

test('os dois endpoints de estado usam bloqueio transacional de linha', () => {
  const fisio = fs.readFileSync(new URL('../services/fisioterapeutasService.js', import.meta.url), 'utf8');
  const localizacao = fs.readFileSync(new URL('../services/localizacoesService.js', import.meta.url), 'utf8');

  for (const source of [fisio, localizacao]) {
    assert.match(source, /Fisioterapeutas WITH \(UPDLOCK, HOLDLOCK\)/);
    assert.match(source, /CrefitoVerificadoAtual/);
    assert.match(source, /EstadoCrefitoBloqueado/);
    assert.match(source, /ESTADO_CREFITO_IMUTAVEL_MESSAGE/);
  }
  assert.match(ESTADO_CREFITO_IMUTAVEL_MESSAGE, /suporte@fisiohelp\.com\.br/);
});

test('pré-compra e compra direta validam jurisdição', () => {
  const source = fs.readFileSync(new URL('../services/pacotesService.js', import.meta.url), 'utf8');
  const calls = source.match(/await validarJurisdicaoCompraPacote\(/g) ?? [];
  assert.equal(calls.length, 2);
  assert.match(source, /p\.Estado AS PacienteEstado/);
  assert.match(source, /f\.Estado AS FisioterapeutaEstado/);
  assert.match(source, /f\.CrefitoVerificado/);
});

test('checkout de pacote revalida antes de chamar o Asaas', () => {
  const source = fs.readFileSync(new URL('../services/pagamentosGatewayService.js', import.meta.url), 'utf8');
  const start = source.indexOf('async criarCheckoutPacoteAsaas');
  const end = source.indexOf('async buscarTransacaoIdPorGatewayReferencia', start);
  const block = source.slice(start, end);

  const validationIndex = block.indexOf('validarJurisdicaoAtendimentoAtual({');
  const asaasIndex = block.indexOf('asaasClient.criarCheckout(checkoutPayload)');
  assert.ok(validationIndex >= 0);
  assert.ok(asaasIndex > validationIndex);
  assert.match(block, /pa\.Estado AS PacienteEstado/);
  assert.match(block, /f\.Estado AS FisioterapeutaEstado/);
  assert.match(block, /f\.CrefitoVerificado/);
});
