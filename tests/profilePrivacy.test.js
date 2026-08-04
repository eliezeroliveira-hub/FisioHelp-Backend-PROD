import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { protegerPerfilPublicoDeDocumento } from '../utils/profilePrivacy.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('remove todos os documentos e metadados profissionais do perfil público', () => {
  const publico = protegerPerfilPublicoDeDocumento({
    Id: 9,
    CPF: '52998224725',
    cpf: '52998224725',
    Cpf: '52998224725',
    FisioterapeutaCPF: '52998224725',
    CNPJ: '11222333000181',
    FisioterapeutaCnpj: '11222333000181',
    TipoPessoa: 'PF',
    DocumentoProfissionalTipo: 'CPF',
    DocumentoProfissionalMascarado: '***.***.***-25',
    CREFITO: '356852-F',
  });

  assert.deepEqual(publico, {
    Id: 9,
    CREFITO: '356852-F',
  });
});

test('preserva valores não-objeto sem tentar transformá-los', () => {
  assert.equal(protegerPerfilPublicoDeDocumento(null), null);
  assert.equal(protegerPerfilPublicoDeDocumento('perfil'), 'perfil');
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

test('V131 remove documento e tipo de pessoa da procedure pública', () => {
  const migration = readProjectFile('sql/FISIOTERAPEUTA_PERFIL_PUBLICO_PRIVACIDADE_V131.sql');
  const procedureDefinition = migration.split('DECLARE @DefinicaoPerfilPublico')[0];

  assert.doesNotMatch(procedureDefinition, /\bf\.CPF\b/i);
  assert.doesNotMatch(procedureDefinition, /\bf\.CNPJ\b/i);
  assert.doesNotMatch(procedureDefinition, /DocumentoProfissional/i);
  assert.doesNotMatch(procedureDefinition, /\bf\.TipoPessoa\b/i);
});
