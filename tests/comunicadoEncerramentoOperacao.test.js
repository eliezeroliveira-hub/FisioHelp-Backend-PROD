import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { montarEmailComunicadoEncerramentoOperacao } from
  '../services/encerramentoOperacaoEmailTemplate.js';

const workerSource = readFileSync(
  new URL('../workers/comunicadoEncerramentoOperacaoWorker.js', import.meta.url),
  'utf8'
);
const functionSource = readFileSync(
  new URL(
    '../azure-functions-workers/src/functions/operarComunicadoEncerramentoOperacao.js',
    import.meta.url
  ),
  'utf8'
);
const indexSource = readFileSync(
  new URL('../azure-functions-workers/src/index.js', import.meta.url),
  'utf8'
);

test('template usa coração tipográfico na cor laranja da marca', () => {
  const email = montarEmailComunicadoEncerramentoOperacao({
    nomeDestinatario: 'Maria da Silva',
  });

  assert.equal(
    email.assunto,
    'Comunicado importante: encerramento das operações da FisioHelp'
  );
  assert.match(email.corpoHtml, /color:#F46337[^>]*>&#x2665;&#xFE0E;<\/span>/);
  assert.doesNotMatch(email.corpoHtml, /🧡|❤️/u);
  assert.match(email.corpoHtml, /Olá, Maria!/);
  assert.match(email.corpoTexto, /30 de novembro de 2026/);
  assert.match(email.corpoTexto, /30 de dezembro de 2026/);
});

test('template usa saudação neutra sem nome', () => {
  const email = montarEmailComunicadoEncerramentoOperacao();
  assert.match(email.corpoHtml, />Olá!</);
  assert.doesNotMatch(email.corpoHtml, /undefined|null/);
});

test('operação exige flag, confirmação, lock e deduplicação por hash', () => {
  assert.match(workerSource, /ENCERRAMENTO_COMUNICADO_ENABLED/);
  assert.match(workerSource, /ENCERRAMENTO-COMUNICADO-2026-11-30/);
  assert.match(workerSource, /sp_getapplock/);
  assert.match(workerSource, /WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(workerSource, /HASHBYTES\(\s*'SHA2_256'/s);
  assert.match(workerSource, /destinatarioHash/);
  assert.match(workerSource, /ROW_NUMBER\(\) OVER/);
  assert.match(workerSource, /FROM dbo\.EmailSupressao/);
  assert.match(workerSource, /N'Promocao'/);
  assert.doesNotMatch(workerSource, /console\.log\([^)]*EmailNormalizado/s);
});

test('endpoint é protegido por function key e registrado no pacote', () => {
  assert.match(functionSource, /authLevel: 'function'/);
  assert.match(functionSource, /methods: \['POST'\]/);
  assert.match(functionSource, /operacoes\/encerramento\/comunicado/);
  assert.match(indexSource, /operarComunicadoEncerramentoOperacao/);
});
