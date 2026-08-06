import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../services/fisioterapeutasService.js', import.meta.url),
  'utf8'
);

const criarStart = source.indexOf('  async criar(dados) {');
const criarEnd = source.indexOf('  async atualizar(id, dados, usuario = null) {', criarStart);
const criarBlock = source.slice(criarStart, criarEnd);

test('cadastro do fisioterapeuta vincula AgoraBrasil como DateTime2(7)', () => {
  assert.ok(criarStart >= 0 && criarEnd > criarStart);
  assert.match(
    criarBlock,
    /req\.input\('AgoraBrasil', sql\.DateTime2\(7\), agoraAppDate\(\)\)/
  );
});

test('DataCadastro e envio do CREFITO usam o mesmo horário de Brasília', () => {
  const insertStart = criarBlock.indexOf('INSERT INTO dbo.Fisioterapeutas');
  const insertEnd = criarBlock.indexOf('DECLARE @FisioId', insertStart);
  const fisioterapeutaInsert = criarBlock.slice(insertStart, insertEnd);

  assert.ok(insertStart >= 0 && insertEnd > insertStart);
  assert.match(fisioterapeutaInsert, /DataCadastro/);
  assert.match(fisioterapeutaInsert, /@AgoraBrasil\s*\n\s*\);/);
  assert.doesNotMatch(fisioterapeutaInsert, /SYSDATETIME\(\)/);

  assert.match(
    criarBlock,
    /@FisioId, N'CREFITO', @CREFITO, N'Pendente', @AgoraBrasil, N'Cadastro'/
  );
});
