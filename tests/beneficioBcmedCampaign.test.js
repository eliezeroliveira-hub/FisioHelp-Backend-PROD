import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  BcmedCampaignError,
  calcularDataFinalInclusiva,
  carregarConfigBeneficioBcmed,
  resolverCiclosBeneficioBcmed,
  verificarLinksBeneficioBcmed,
} from '../utils/beneficioBcmedCampaign.js';

function baseEnv(overrides = {}) {
  return {
    BCMED_BENEFICIO_WORKER_ENABLED: 'true',
    BCMED_BENEFICIO_EMAIL_ENABLED: 'true',
    BCMED_BENEFICIO_PUSH_ENABLED: 'true',
    BCMED_BENEFICIO_CAMPANHA_ID: 'beneficio-bcmed-2026',
    BCMED_BENEFICIO_DATA_INICIAL: '2026-09-22',
    BCMED_BENEFICIO_DATA_FINAL: '2026-12-21',
    BCMED_BENEFICIO_EMAIL_INTERVAL_DAYS: '20',
    BCMED_BENEFICIO_PUSH_INTERVAL_DAYS: '10',
    BCMED_BENEFICIO_TOLERANCIA_DIAS: '3',
    BCMED_BENEFICIO_WHATSAPP_PHONE_SHA256: 'a'.repeat(64),
    ...overrides,
  };
}

function saoPauloNoon(dateOnly) {
  return new Date(`${dateOnly}T15:00:00.000Z`);
}

test('calcula data final inclusiva em 90 dias', () => {
  assert.equal(calcularDataFinalInclusiva('2026-09-22', 90), '2026-12-21');
});

test('configuração desativada não exige segredos nem datas', () => {
  assert.deepEqual(carregarConfigBeneficioBcmed({}), {
    enabled: false,
    emailEnabled: false,
    pushEnabled: false,
  });
});

test('configuração ativa valida período, tolerância e campanha', () => {
  const config = carregarConfigBeneficioBcmed(baseEnv());
  assert.equal(config.dataInicial, '2026-09-22');
  assert.equal(config.dataFinal, '2026-12-21');
  assert.equal(config.emailIntervalDays, 20);
  assert.equal(config.pushIntervalDays, 10);

  assert.throws(
    () => carregarConfigBeneficioBcmed(baseEnv({ BCMED_BENEFICIO_DATA_FINAL: '' })),
    (error) => error instanceof BcmedCampaignError && error.code === 'BCMED_CONFIG_INVALID'
  );
  assert.throws(
    () => carregarConfigBeneficioBcmed(baseEnv({ BCMED_BENEFICIO_TOLERANCIA_DIAS: '10' })),
    /tolerância deve ser menor/
  );
  assert.throws(
    () => carregarConfigBeneficioBcmed(baseEnv({ BCMED_BENEFICIO_CAMPANHA_ID: 'INVÁLIDA' })),
    /\[a-z0-9-\]/
  );
});

test('alvo piloto aceita e-mail normalizado e impede filtros concorrentes', () => {
  const config = carregarConfigBeneficioBcmed(baseEnv({
    BCMED_BENEFICIO_FISIOTERAPEUTA_EMAIL: '  PLAY-REVIEW-FISIO@FISIOHELP.COM.BR ',
  }));
  assert.equal(config.fisioterapeutaEmailAlvo, 'play-review-fisio@fisiohelp.com.br');
  assert.equal(config.fisioterapeutaIdAlvo, null);

  assert.throws(
    () => carregarConfigBeneficioBcmed(baseEnv({
      BCMED_BENEFICIO_FISIOTERAPEUTA_EMAIL: 'e-mail-invalido',
    })),
    /e-mail válido/
  );
  assert.throws(
    () => carregarConfigBeneficioBcmed(baseEnv({
      BCMED_BENEFICIO_FISIOTERAPEUTA_ID: '36',
      BCMED_BENEFICIO_FISIOTERAPEUTA_EMAIL: 'play-review-fisio@fisiohelp.com.br',
    })),
    /somente um alvo piloto/
  );
});

test('resolve ciclos independentes e tolerância inclusiva', () => {
  const config = carregarConfigBeneficioBcmed(baseEnv());
  const cases = [
    ['2026-09-22', true, 0, true, 0],
    ['2026-09-25', true, 0, true, 0],
    ['2026-09-26', false, 0, false, 0],
    ['2026-10-02', false, 0, true, 1],
    ['2026-10-05', false, 0, true, 1],
    ['2026-10-06', false, 0, false, 1],
    ['2026-10-12', true, 1, true, 2],
    ['2026-10-22', false, 1, true, 3],
    ['2026-11-01', true, 2, true, 4],
    ['2026-12-21', false, 4, true, 9],
  ];

  for (const [date, emailExec, emailCycle, pushExec, pushCycle] of cases) {
    const result = resolverCiclosBeneficioBcmed(config, saoPauloNoon(date));
    assert.equal(result.email.executar, emailExec, `email em ${date}`);
    assert.equal(result.email.ciclo, emailCycle, `ciclo e-mail em ${date}`);
    assert.equal(result.push.executar, pushExec, `push em ${date}`);
    assert.equal(result.push.ciclo, pushCycle, `ciclo push em ${date}`);
  }

  const final = resolverCiclosBeneficioBcmed(config, saoPauloNoon('2026-12-21'));
  assert.equal(final.push.expiraEm, '2026-12-21');
  const after = resolverCiclosBeneficioBcmed(config, saoPauloNoon('2026-12-22'));
  assert.equal(after.email.executar, false);
  assert.equal(after.push.executar, false);
});

function response(status, location = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return name.toLowerCase() === 'location' ? location : null;
      },
    },
  };
}

test('valida o redirecionamento sem requisitar o WhatsApp', async () => {
  const phone = '5531999999999';
  const calls = [];
  const config = {
    bcmedUrl: 'https://www.bcmed.com.br/fisioterapia',
    beneficioUrl: 'https://compreno.link/FisioHelp',
    whatsappHosts: new Set(['api.whatsapp.com']),
    whatsappPhoneSha256: crypto.createHash('sha256').update(phone).digest('hex'),
    whatsappMessageToken: 'FisioHelp',
    linkCheckTimeoutMs: 5_000,
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    if (calls.length === 1) return response(200);
    return response(
      301,
      'https://api.whatsapp.com/send?phone=55%2031%2099999-9999&text=Vim%20atrav%C3%A9s%20da%20FisioHelp'
    );
  };

  assert.deepEqual(await verificarLinksBeneficioBcmed(config, { fetchImpl }), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.url.includes('whatsapp.com')), false);
});

test('falha fechada quando o número ou host do destino diverge', async () => {
  const expectedHash = crypto.createHash('sha256').update('5531999999999').digest('hex');
  const config = {
    bcmedUrl: 'https://www.bcmed.com.br/fisioterapia',
    beneficioUrl: 'https://compreno.link/FisioHelp',
    whatsappHosts: new Set(['api.whatsapp.com']),
    whatsappPhoneSha256: expectedHash,
    whatsappMessageToken: 'FisioHelp',
    linkCheckTimeoutMs: 5_000,
  };

  await assert.rejects(
    verificarLinksBeneficioBcmed(config, {
      fetchImpl: async (url) => String(url).includes('bcmed.com.br')
        ? response(200)
        : response(301, 'https://api.whatsapp.com/send?phone=5511000000000&text=FisioHelp'),
    }),
    /número de destino/
  );

  await assert.rejects(
    verificarLinksBeneficioBcmed(config, {
      fetchImpl: async (url) => String(url).includes('bcmed.com.br')
        ? response(200)
        : response(301, 'https://example.com/internal?phone=5531999999999&text=FisioHelp'),
    }),
    /destino não permitido/
  );
});
