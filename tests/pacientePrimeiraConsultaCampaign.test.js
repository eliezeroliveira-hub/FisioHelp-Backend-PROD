import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PacientePrimeiraConsultaCampaignError,
  carregarConfigPacientePrimeiraConsulta,
  obterControleDespachoPacientePrimeiraConsulta,
} from '../utils/pacientePrimeiraConsultaCampaign.js';

function baseEnv(overrides = {}) {
  return {
    PACIENTE_ATIVACAO_WORKER_ENABLED: 'true',
    PACIENTE_ATIVACAO_EMAIL_ENABLED: 'true',
    PACIENTE_ATIVACAO_CAMPANHA_ID: 'ativacao-primeira-consulta-2026',
    PACIENTE_ATIVACAO_DATA_INICIAL: '2026-10-20',
    ...overrides,
  };
}

test('configuração desativada não exige campanha ou data', () => {
  assert.deepEqual(carregarConfigPacientePrimeiraConsulta({}), {
    enabled: false,
    emailEnabled: false,
  });
});

test('configuração valida piloto, exclusões e links aprovados', () => {
  const config = carregarConfigPacientePrimeiraConsulta(baseEnv({
    PACIENTE_ATIVACAO_PACIENTE_EMAIL: ' PLAY-REVIEW-PACIENTE@FISIOHELP.COM.BR ',
    PACIENTE_ATIVACAO_PILOTO_FORCAR_DIA: '1',
    PACIENTE_ATIVACAO_PILOTO_EXCLUSIVO: 'true',
    PACIENTE_ATIVACAO_PACIENTE_IDS_EXCLUIDOS: '[2, 2, 7]',
    PACIENTE_ATIVACAO_PACIENTE_EMAILS_EXCLUIDOS: '["teste@example.com"]',
  }));

  assert.equal(config.pacienteEmailAlvo, 'play-review-paciente@fisiohelp.com.br');
  assert.equal(config.pilotoForcarDia, 1);
  assert.equal(config.pilotoExclusivo, true);
  assert.deepEqual(config.pacienteIdsExcluidos, [2, 7]);
  assert.deepEqual(config.pacienteEmailsExcluidos, ['teste@example.com']);
  assert.deepEqual(config.dominiosTeste, ['fisiohelp.com.br']);
  assert.match(config.fisioterapeutasUrl, /utm_campaign=ativacao_primeira_consulta/);
});

test('recusa configuração inválida ou ciclo forçado sem piloto', () => {
  const invalidCases = [
    [{ PACIENTE_ATIVACAO_CAMPANHA_ID: 'INVÁLIDA' }, /\[a-z0-9-\]/],
    [{ PACIENTE_ATIVACAO_DATA_INICIAL: '21-10-2026' }, /YYYY-MM-DD/],
    [{ PACIENTE_ATIVACAO_PILOTO_FORCAR_DIA: '1' }, /exige um e-mail piloto/],
    [{ PACIENTE_ATIVACAO_PILOTO_EXCLUSIVO: 'true' }, /exige PACIENTE_ATIVACAO_PACIENTE_EMAIL/],
    [{
      PACIENTE_ATIVACAO_PACIENTE_EMAIL: 'piloto@example.com',
      PACIENTE_ATIVACAO_PILOTO_FORCAR_DIA: '3',
    }, /deve ser 1, 4 ou 10/],
    [{ PACIENTE_ATIVACAO_VIDEO_URL: 'https://example.com/video' }, /host permitido/],
  ];

  for (const [override, pattern] of invalidCases) {
    assert.throws(
      () => carregarConfigPacientePrimeiraConsulta(baseEnv(override)),
      (error) =>
        error instanceof PacientePrimeiraConsultaCampaignError &&
        pattern.test(error.message)
    );
  }
});

test('controle fecha o claim quando a configuração está inválida', () => {
  const controle = obterControleDespachoPacientePrimeiraConsulta(
    baseEnv({ PACIENTE_ATIVACAO_DATA_INICIAL: '' }),
    new Date('2026-10-21T15:00:00.000Z')
  );
  assert.equal(controle.emailEnabled, false);
  assert.match(controle.configError, /YYYY-MM-DD/);
  assert.equal(controle.hojeBrasil, '2026-10-21');
});
