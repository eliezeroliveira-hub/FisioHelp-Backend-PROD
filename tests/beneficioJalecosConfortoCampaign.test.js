import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JalecosConfortoCampaignError,
  calcularDataFinalInclusiva,
  carregarConfigBeneficioJalecosConforto,
  resolverCiclosBeneficioJalecosConforto,
  verificarLinksBeneficioJalecosConforto,
} from '../utils/beneficioJalecosConfortoCampaign.js';

function baseEnv(overrides = {}) {
  return {
    JALECOS_CONFORTO_WORKER_ENABLED: 'true',
    JALECOS_CONFORTO_EMAIL_ENABLED: 'true',
    JALECOS_CONFORTO_PUSH_ENABLED: 'true',
    JALECOS_CONFORTO_CAMPANHA_ID: 'beneficio-jalecos-conforto-2026',
    JALECOS_CONFORTO_DATA_INICIAL: '2026-10-01',
    JALECOS_CONFORTO_DATA_FINAL: '2026-12-30',
    JALECOS_CONFORTO_EMAIL_INTERVAL_DAYS: '20',
    JALECOS_CONFORTO_PUSH_INTERVAL_DAYS: '10',
    JALECOS_CONFORTO_TOLERANCIA_DIAS: '3',
    ...overrides,
  };
}

function saoPauloNoon(dateOnly) {
  return new Date(`${dateOnly}T15:00:00.000Z`);
}

function response(status, location = null) {
  return {
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === 'location' ? location : null;
      },
    },
  };
}

test('configuração Jalecos desativada não exige datas nem campanha', () => {
  assert.deepEqual(carregarConfigBeneficioJalecosConforto({}), {
    enabled: false,
    emailEnabled: false,
    pushEnabled: false,
  });
});

test('valida período, campanha, URL, cupom e alvo piloto', () => {
  const config = carregarConfigBeneficioJalecosConforto(baseEnv({
    JALECOS_CONFORTO_FISIOTERAPEUTA_EMAIL: ' PLAY-REVIEW-FISIO@FISIOHELP.COM.BR ',
  }));
  assert.equal(config.beneficioUrl, 'https://www.jalecosconforto.com.br/');
  assert.equal(config.cupom, 'FisioHelp');
  assert.equal(config.fisioterapeutaEmailAlvo, 'play-review-fisio@fisiohelp.com.br');

  const invalidCases = [
    [{ JALECOS_CONFORTO_DATA_FINAL: '' }, /YYYY-MM-DD/],
    [{ JALECOS_CONFORTO_TOLERANCIA_DIAS: '10' }, /tolerância deve ser menor/],
    [{ JALECOS_CONFORTO_CAMPANHA_ID: 'INVÁLIDA' }, /\[a-z0-9-\]/],
    [{ JALECOS_CONFORTO_URL: 'https://example.com/' }, /host não permitido/],
    [{ JALECOS_CONFORTO_CUPOM: 'cupom inválido' }, /CUPOM/],
  ];
  for (const [override, pattern] of invalidCases) {
    assert.throws(
      () => carregarConfigBeneficioJalecosConforto(baseEnv(override)),
      (error) => error instanceof JalecosConfortoCampaignError && pattern.test(error.message)
    );
  }

  assert.throws(
    () => carregarConfigBeneficioJalecosConforto(baseEnv({
      JALECOS_CONFORTO_FISIOTERAPEUTA_ID: '36',
      JALECOS_CONFORTO_FISIOTERAPEUTA_EMAIL: 'play-review-fisio@fisiohelp.com.br',
    })),
    /somente um alvo piloto/
  );
});

test('calcula 90 dias e ciclos independentes com tolerância inclusiva', () => {
  assert.equal(calcularDataFinalInclusiva('2026-10-01', 90), '2026-12-30');
  const config = carregarConfigBeneficioJalecosConforto(baseEnv());
  const cases = [
    ['2026-10-01', true, 0, true, 0],
    ['2026-10-04', true, 0, true, 0],
    ['2026-10-05', false, 0, false, 0],
    ['2026-10-11', false, 0, true, 1],
    ['2026-10-14', false, 0, true, 1],
    ['2026-10-21', true, 1, true, 2],
    ['2026-10-31', false, 1, true, 3],
    ['2026-11-10', true, 2, true, 4],
    ['2026-12-30', false, 4, true, 9],
  ];
  for (const [date, emailExec, emailCycle, pushExec, pushCycle] of cases) {
    const result = resolverCiclosBeneficioJalecosConforto(config, saoPauloNoon(date));
    assert.equal(result.email.executar, emailExec, `email em ${date}`);
    assert.equal(result.email.ciclo, emailCycle, `ciclo e-mail em ${date}`);
    assert.equal(result.push.executar, pushExec, `push em ${date}`);
    assert.equal(result.push.ciclo, pushCycle, `ciclo push em ${date}`);
  }
  const final = resolverCiclosBeneficioJalecosConforto(config, saoPauloNoon('2026-12-30'));
  assert.equal(final.push.expiraEm, '2026-12-30');
});

test('link checker aceita apenas resposta direta HTTPS de sucesso', async () => {
  const config = carregarConfigBeneficioJalecosConforto(baseEnv());
  const calls = [];
  assert.deepEqual(
    await verificarLinksBeneficioJalecosConforto(config, {
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), ...options });
        return response(200);
      },
    }),
    { ok: true }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'HEAD');
  assert.equal(calls[0].redirect, 'manual');

  await assert.rejects(
    verificarLinksBeneficioJalecosConforto(config, {
      fetchImpl: async () => response(301, 'https://example.com/'),
    }),
    /não respondeu com sucesso/
  );
});
