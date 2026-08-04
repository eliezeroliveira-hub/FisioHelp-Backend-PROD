import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { protegerPerfilPublicoDeCpf } from '../utils/profilePrivacy.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('remove CPF e aliases equivalentes do perfil público', () => {
  const publico = protegerPerfilPublicoDeCpf({
    Id: 9,
    CPF: '52998224725',
    cpf: '52998224725',
    Cpf: '52998224725',
    FisioterapeutaCPF: '52998224725',
    TipoPessoa: 'PF',
    DocumentoProfissionalTipo: 'CPF',
    DocumentoProfissionalMascarado: '***.***.***-25',
  });

  assert.deepEqual(publico, {
    Id: 9,
    TipoPessoa: 'PF',
    DocumentoProfissionalTipo: 'CPF',
    DocumentoProfissionalMascarado: '***.***.***-25',
  });
});

test('preserva CNPJ público para retrocompatibilidade de fisioterapeuta PJ', () => {
  const publico = protegerPerfilPublicoDeCpf({
    TipoPessoa: 'PJ',
    CNPJ: '11222333000181',
    DocumentoProfissionalTipo: 'CNPJ',
    DocumentoProfissionalMascarado: '**.***.***/****-81',
  });

  assert.equal(publico.CNPJ, '11222333000181');
  assert.equal(publico.DocumentoProfissionalTipo, 'CNPJ');
});

test('perfil completo seleciona e retorna TipoPessoa, CPF e CNPJ', () => {
  const service = readProjectFile('services/fisioterapeutasService.js');
  const controller = readProjectFile('controllers/fisioterapeutasController.js');

  assert.match(service, /f\.TipoPessoa,\s*f\.CPF,\s*f\.CNPJ,/);
  assert.match(controller, /TipoPessoa:\s*f\.TipoPessoa\s*\?\?\s*null,/);
  assert.match(controller, /CPF:\s*f\.CPF\s*\?\?\s*null,/);
  assert.match(controller, /CNPJ:\s*f\.CNPJ\s*\?\?\s*null,/);
});

test('Admin recebe PF/PJ e permite busca por CPF normalizado', () => {
  const service = readProjectFile('services/adminService.js');

  assert.match(service, /f\.TipoPessoa,\s*f\.CPF,\s*f\.CNPJ,/);
  assert.match(service, /AS DocumentoProfissionalTipo,/);
  assert.match(service, /AS DocumentoProfissional,/);
  assert.match(service, /@BuscaCpf IS NOT NULL AND f\.CPF LIKE @BuscaCpf/);
});

test('procedure pública retorna somente CPF mascarado', () => {
  const migration = readProjectFile('sql/FISIOTERAPEUTAS_PF_PJ_DOCUMENTOS_GLOBAIS_V130.sql');

  assert.match(migration, /AS DocumentoProfissionalMascarado,/);
  assert.match(migration, /THEN CONCAT\(N''\*\*\*\.\*\*\*\.\*\*\*-''\s*,\s*RIGHT\(f\.CPF, 2\)\)/);
  assert.doesNotMatch(migration, /f\.CPF\s+AS\s+(?:CPF|Cpf)\b/i);
});
