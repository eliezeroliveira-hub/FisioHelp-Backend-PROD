import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const serviceSource = readFileSync(
  new URL('../services/encerramentoProntuariosService.js', import.meta.url),
  'utf8'
);
const functionSource = readFileSync(
  new URL(
    '../azure-functions-workers/src/functions/operarProntuariosEncerramento.js',
    import.meta.url
  ),
  'utf8'
);
const indexSource = readFileSync(
  new URL('../azure-functions-workers/src/index.js', import.meta.url),
  'utf8'
);

test('exportação reutiliza o mesmo gerador PDF do app e adiciona AES-256', () => {
  assert.match(serviceSource, /import \{ gerarPdfBuffer \} from '\.\/prontuariosService\.js'/);
  assert.match(serviceSource, /gerarPdfBuffer\(row, \{/);
  assert.match(serviceSource, /pdfVersion: '1\.7ext3'/);
  assert.match(serviceSource, /userPassword: password\.value/);
  assert.match(serviceSource, /buffer\.includes\(Buffer\.from\('\/Encrypt'\)\)/);
});

test('operação é temporária, confirmada e não contém envio de e-mail', () => {
  assert.match(serviceSource, /ENCERRAMENTO_PRONTUARIOS_ENABLED/);
  assert.match(serviceSource, /INVENTARIAR-PRONTUARIOS-PROD-2026-11-03/);
  assert.match(serviceSource, /EXPORTAR-PRONTUARIO-LOCAL-VALIDACAO-2026-11-03/);
  assert.doesNotMatch(serviceSource, /enviarEmail|emailProvider|FilaNotificacoes/);
});

test('endpoint exige function key, não usa cache e está registrado', () => {
  assert.match(functionSource, /authLevel: 'function'/);
  assert.match(functionSource, /methods: \['POST'\]/);
  assert.match(functionSource, /Cache-Control': 'no-store, private'/);
  assert.match(functionSource, /application\/pdf/);
  assert.match(indexSource, /operarProntuariosEncerramento/);
});

test('inventário separa registros que exigem revisão manual', () => {
  assert.match(serviceSource, /play-review/);
  assert.match(serviceSource, /classificacao: 'RevisaoManual'/);
  assert.match(serviceSource, /classificacao: 'Real'/);
  assert.match(serviceSource, /aprovadoParaExportacao: false/);
});
