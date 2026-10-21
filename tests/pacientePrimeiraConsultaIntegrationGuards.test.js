import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const serviceSource = readFileSync(
  new URL('../services/notificacoesService.js', import.meta.url),
  'utf8'
);
const workerSource = readFileSync(
  new URL('../workers/pacientePrimeiraConsultaWorker.js', import.meta.url),
  'utf8'
);
const notificationWorkerSource = readFileSync(
  new URL('../workers/notificacoesWorker.js', import.meta.url),
  'utf8'
);
const functionSource = readFileSync(
  new URL(
    '../azure-functions-workers/src/functions/enfileirarAtivacaoPrimeiraConsultaPaciente.js',
    import.meta.url
  ),
  'utf8'
);
const indexSource = readFileSync(
  new URL('../azure-functions-workers/src/index.js', import.meta.url),
  'utf8'
);

function claimSource() {
  const start = serviceSource.indexOf('async function reivindicarLote(');
  const end = serviceSource.indexOf('async function listarDispositivosAtivos(', start);
  assert.ok(start >= 0 && end > start);
  return serviceSource.slice(start, end);
}

test('elegibilidade exclui consultas, fisios, supressão e contas de teste', () => {
  assert.match(workerSource, /NOT EXISTS \(\s*SELECT 1 FROM dbo\.Consultas/s);
  assert.match(workerSource, /FROM dbo\.Fisioterapeutas f/);
  assert.match(workerSource, /FROM dbo\.EmailSupressao es/);
  assert.match(workerSource, /@DominiosTesteJson/);
  assert.match(workerSource, /@EmailsExcluidosJson/);
  assert.match(workerSource, /ISNULL\(p\.EmailVerificado, 0\) = 1/);
});

test('ciclos são 1, 4 e 10 sem sobreposição e com âncora da campanha', () => {
  assert.match(workerSource, /p\.DataCadastro < @DataInicial/);
  assert.match(workerSource, /DATEADD\(DAY, 10, b\.DataAncora\)/);
  assert.match(workerSource, /DATEADD\(DAY, 13, b\.DataAncora\)/);
  assert.match(workerSource, /DATEADD\(DAY, 4, b\.DataAncora\)/);
  assert.match(workerSource, /DATEADD\(DAY, 1, b\.DataAncora\)/);
  assert.match(workerSource, /c\.CicloDia = 1/);
  assert.match(workerSource, /c\.CicloDia = 4/);
  assert.match(workerSource, /c\.CicloDia = 10/);
});

test('deduplicação inclui campanha, data inicial, paciente e ciclo', () => {
  assert.match(workerSource, /sp_getapplock/);
  assert.match(workerSource, /WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(workerSource, /@CampanhaId/);
  assert.match(workerSource, /@DataInicial/);
  assert.match(workerSource, /@CicloDia/);
  assert.match(workerSource, /@PacienteId/);
});

test('claim aplica kill switch e revalida ausência de consulta antes do TOP', () => {
  const claim = claimSource();
  const filterIndex = claim.indexOf('@PacientePrimeiraConsultaDadosTipo');
  const topIndex = claim.indexOf('SELECT TOP (@BatchSize)');
  assert.ok(filterIndex >= 0 && filterIndex < topIndex);
  assert.match(claim, /@PacientePrimeiraConsultaEmailEnabled/);
  assert.match(claim, /@PacientePrimeiraConsultaPilotoExclusivo = 0/);
  assert.match(claim, /FROM dbo\.Consultas c/);
  assert.match(claim, />= @HojeBrasil/);
  assert.match(serviceSource, /pacienteAtivacaoAindaSemConsulta/);
  assert.match(serviceSource, /paciente_com_consulta/);
});

test('processador carrega controle isolado da ativação', () => {
  assert.match(
    notificationWorkerSource,
    /obterControleDespachoPacientePrimeiraConsulta/
  );
  assert.match(notificationWorkerSource, /controlePacientePrimeiraConsulta/);
});

test('timer roda a cada hora, sem startup, e está registrado', () => {
  assert.match(functionSource, /schedule: '0 25 \* \* \* \*'/);
  assert.match(functionSource, /runOnStartup: false/);
  assert.match(functionSource, /useMonitor: true/);
  assert.match(indexSource, /enfileirarAtivacaoPrimeiraConsultaPaciente/);
});
