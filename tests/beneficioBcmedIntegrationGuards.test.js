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
const notificationWorkerSource = readFileSync(
  new URL('../workers/notificacoesWorker.js', import.meta.url),
  'utf8'
);
const reliabilitySource = readFileSync(
  new URL('../utils/acsEmailReliability.js', import.meta.url),
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
  assert.match(workerSource, /Diagnóstico seguro do alvo piloto BCMED/);
  assert.match(workerSource, /TemDispositivoAtivo/);
  assert.match(workerSource, /fisioterapeutaEmailAlvoConfigurado: Boolean/);
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

test('ACS usa idempotencia, retomada e timeout por requisicao', () => {
  assert.match(emailProviderSource, /beginSend\(message, \{/);
  assert.match(emailProviderSource, /operationId:/);
  assert.match(emailProviderSource, /resumeFrom:/);
  assert.match(emailProviderSource, /abortSignal/);
  assert.match(emailProviderSource, /getSendResult/);
  assert.match(emailProviderSource, /consultarOperacaoAcsExistente/);
  assert.match(reliabilitySource, /poller\.poll\(\{ abortSignal \}\)/);
  assert.match(reliabilitySource, /Promise\.race/);

  assert.match(serviceSource, /criarOperationIdFilaNotificacao\(filaId, ENV\.DB_NAME\)/);
  assert.match(serviceSource, /\$\.acsEmail/);
  assert.match(serviceSource, /salvarEstadoAcsEmail/);
  assert.match(serviceSource, /consultarOperationIdAntesDeEnviar/);
});

test('worker limita o tick e devolve itens ainda nao iniciados', () => {
  assert.match(notificationWorkerSource, /NOTIF_WORKER_MAX_TICK_MS/);
  assert.match(notificationWorkerSource, /480_000/);
  assert.match(notificationWorkerSource, /devolverProcessandoParaPendente/);
  assert.match(notificationWorkerSource, /lote\.slice\(index\)/);
  assert.match(serviceSource, /OPENJSON\(@IdsJson\)/);
  assert.match(serviceSource, /fn\.\[Status\] = N'Pendente'/);
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
