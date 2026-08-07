import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../services/fisioterapeutasService.js', import.meta.url),
  'utf8'
);

test('cadastro usa o último result set para identificar o fisioterapeuta criado', () => {
  assert.match(source, /const insertRecordsets = Array\.isArray\(insert\.recordsets\)/);
  assert.match(source, /insertRecordsets\[insertRecordsets\.length - 1\]/);
  assert.match(source, /const novoId = Number\(idRecordset\?\.\[0\]\?\.Id\)/);
  assert.doesNotMatch(source, /const novoId = insert\.recordset\[0\]\.Id/);
});

test('cadastro aguarda a criação da verificação de e-mail', () => {
  assert.match(source, /const verificacao = await solicitarVerificacaoContatoInterna\(\{/);
  assert.match(source, /fisio\.verificacaoEmailEnviada = true/);
  assert.doesNotMatch(source, /void solicitarVerificacaoContatoInterna\(\{/);
});
