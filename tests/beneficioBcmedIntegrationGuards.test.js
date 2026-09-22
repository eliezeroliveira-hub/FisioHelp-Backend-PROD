import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { sanitizeRemoteUrl } from '../azure-functions-workers/scripts/build-info.mjs';

const serviceSource = readFileSync(
  new URL('../services/notificacoesService.js', import.meta.url),
  'utf8'
);
const workerSource = readFileSync(
  new URL('../workers/beneficioBcmedFisioterapeutaWorker.js', import.meta.url),
  'utf8'
);
const functionSource = readFileSync(
  new URL(
    '../azure-functions-workers/src/functions/enfileirarBeneficioBcmedFisioterapeuta.js',
    import.meta.url
  ),
  'utf8'
);
const emailProviderSource = readFileSync(
  new URL('../providers/emailProvider.js', import.meta.url),
  'utf8'
);
const pushProviderSource = readFileSync(
  new URL('../providers/pushProvider.js', import.meta.url),
  'utf8'
);

test('claim filtra BCMED antes do TOP com JSON seguro, pausa e expiração', () => {
  const topIndex = serviceSource.indexOf('SELECT TOP (@BatchSize)');
  const orderIndex = serviceSource.indexOf('ORDER BY [ProximaTentativaEm]', topIndex);
  const claimBlock = serviceSource.slice(topIndex, orderIndex);

  assert.match(claimBlock, /ISJSON\(\[DadosJson\]\) = 1/);
  assert.match(claimBlock, /@BcmedEmailEnabled/);
  assert.match(claimBlock, /@BcmedPushEnabled/);
  assert.match(claimBlock, /TRY_CONVERT\(/);
  assert.match(claimBlock, /23/);
  assert.match(claimBlock, />= @HojeBrasil/);
});

test('worker lê configuração no tick e protege push, inbox e deduplicação', () => {
  const tickIndex = workerSource.indexOf('export async function tick()');
  const configReadIndex = workerSource.indexOf(
    'carregarConfigBeneficioBcmed(process.env)',
    tickIndex
  );
  assert.ok(configReadIndex > tickIndex);
  assert.match(workerSource, /fe\.Status = N'Enviado'/);
  assert.match(workerSource, /IF @Canal = N'push' AND @Ciclo = 0/);
  assert.match(workerSource, /sp_getapplock/);
  assert.match(workerSource, /WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(workerSource, /FisioterapeutaEmailAlvo/);
  assert.match(workerSource, /BCMED_LINK_CHECK_FAILED/);
  assert.match(workerSource, /BCMED_ENQUEUE_FAILED/);
});

test('timer BCMED é diário, 09h de São Paulo, sem runOnStartup', () => {
  assert.match(functionSource, /schedule: '0 0 12 \* \* \*'/);
  assert.match(functionSource, /runOnStartup: false/);
});

test('providers existentes tratam limites como falha temporária', () => {
  assert.match(emailProviderSource, /statusCode === 429/);
  assert.match(emailProviderSource, /tempFalha/);
  assert.match(pushProviderSource, /status === 429/);
  assert.match(pushProviderSource, /tempFalha/);
});

test('sanitiza credenciais do remoto no BUILD_INFO', () => {
  assert.equal(
    sanitizeRemoteUrl('https://usuario:token@github.com/org/repo.git'),
    'https://github.com/org/repo'
  );
  assert.equal(
    sanitizeRemoteUrl('git@github.com:org/repo.git'),
    'github.com/org/repo'
  );
});
