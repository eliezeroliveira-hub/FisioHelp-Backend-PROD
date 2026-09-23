import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const serviceSource = readFileSync(
  new URL('../services/notificacoesService.js', import.meta.url),
  'utf8'
);
const workerSource = readFileSync(
  new URL('../workers/beneficioJalecosConfortoFisioterapeutaWorker.js', import.meta.url),
  'utf8'
);
const notificationWorkerSource = readFileSync(
  new URL('../workers/notificacoesWorker.js', import.meta.url),
  'utf8'
);
const functionSource = readFileSync(
  new URL(
    '../azure-functions-workers/src/functions/enfileirarBeneficioJalecosConfortoFisioterapeuta.js',
    import.meta.url
  ),
  'utf8'
);
const indexSource = readFileSync(
  new URL('../azure-functions-workers/src/index.js', import.meta.url),
  'utf8'
);
const packageSource = readFileSync(
  new URL('../azure-functions-workers/package.json', import.meta.url),
  'utf8'
);

function claimSource() {
  const start = serviceSource.indexOf('async function reivindicarLote(');
  const end = serviceSource.indexOf('async function listarDispositivosAtivos(', start);
  assert.ok(start >= 0 && end > start);
  return serviceSource.slice(start, end);
}

test('claim filtra as duas campanhas antes do TOP e aplica limite distribuído', () => {
  const claim = claimSource();
  const filterIndex = claim.indexOf('@JalecosConfortoDadosTipo');
  const topIndex = claim.indexOf('SELECT TOP (@BatchSize)');

  assert.ok(filterIndex >= 0 && filterIndex < topIndex);
  assert.match(claim, /@BcmedEmailEnabled/);
  assert.match(claim, /@JalecosConfortoEmailEnabled/);
  assert.match(claim, /@JalecosConfortoPushEnabled/);
  assert.match(claim, /ISJSON\(\[DadosJson\]\) = 1/);
  assert.match(claim, /TRY_CONVERT\(/);
  assert.match(claim, />= @HojeBrasil/);
  assert.match(claim, /notificacoes:claim:v2/);
  assert.match(claim, /sp_getapplock/);
  assert.match(claim, /DATEADD\(MINUTE, -60, SYSDATETIME\(\)\)/);
  assert.match(claim, /DATEADD\(SECOND, -60, SYSDATETIME\(\)\)/);
  assert.match(claim, /@PromocaoEmailMax60Min/);
  assert.match(claim, /ROW_NUMBER\(\) OVER/);
  assert.match(claim, /\[OrdemEmailPromocional\] = 1/);
});

test('worker Jalecos protege push, inbox, deduplicação e isolamento', () => {
  const tickIndex = workerSource.indexOf('export async function tick()');
  const configReadIndex = workerSource.indexOf(
    'carregarConfigBeneficioJalecosConforto(process.env)',
    tickIndex
  );
  assert.ok(configReadIndex > tickIndex);
  assert.match(workerSource, /JALECOS_CONFORTO_DADOS_TIPO/);
  assert.match(workerSource, /fe\.Status = N'Enviado'/);
  assert.match(workerSource, /IF @Canal = N'push' AND @Ciclo = 0/);
  assert.match(workerSource, /sp_getapplock/);
  assert.match(workerSource, /WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(workerSource, /JALECOS_CONFORTO_LINK_CHECK_FAILED/);
  assert.match(workerSource, /JALECOS_CONFORTO_ENQUEUE_FAILED/);
  assert.doesNotMatch(workerSource, /beneficioBcmedFisioterapeutaWorker/);
});

test('processador lê controle Jalecos e teto promocional', () => {
  assert.match(notificationWorkerSource, /obterControleDespachoBeneficioJalecosConforto/);
  assert.match(notificationWorkerSource, /NOTIF_PROMO_EMAIL_MAX_60_MIN/);
  assert.match(notificationWorkerSource, /promocaoEmailMax60Min/);
  assert.match(notificationWorkerSource, /controleJalecosConforto/);
});

test('timer Jalecos é diário às 09h10 de São Paulo e não roda no startup', () => {
  assert.match(functionSource, /schedule: '0 10 12 \* \* \*'/);
  assert.match(functionSource, /runOnStartup: false/);
  assert.match(functionSource, /useMonitor: true/);
  assert.match(indexSource, /enfileirarBeneficioJalecosConfortoFisioterapeuta/);
  assert.match(packageSource, /enfileirarBeneficioJalecosConfortoFisioterapeuta\.js/);
});
