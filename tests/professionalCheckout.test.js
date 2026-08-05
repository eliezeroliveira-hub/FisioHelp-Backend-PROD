import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { montarPrestadorCheckout } from '../utils/professionalCheckout.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('monta prestador PF com CPF normalizado para o checkout', () => {
  const prestador = montarPrestadorCheckout({
    TipoPessoa: 'PF',
    CPF: '529.982.247-25',
    CNPJ: null,
  });

  assert.deepEqual(prestador, {
    TipoPessoa: 'PF',
    DocumentoTipo: 'CPF',
    Documento: '52998224725',
  });
  assert.equal(Object.isFrozen(prestador), true);
});

test('monta prestador PJ com CNPJ normalizado para o checkout', () => {
  const prestador = montarPrestadorCheckout({
    TipoPessoa: 'PJ',
    CPF: null,
    CNPJ: '11.222.333/0001-81',
  });

  assert.deepEqual(prestador, {
    TipoPessoa: 'PJ',
    DocumentoTipo: 'CNPJ',
    Documento: '11222333000181',
  });
});

test('não devolve detalhes do dado inconsistente na mensagem de erro', () => {
  assert.throws(
    () => montarPrestadorCheckout({ TipoPessoa: 'PF', CPF: '11111111111' }),
    /Documento do prestador indisponível para o checkout\./
  );
});

test('somente os pré-checkouts autenticados incluem Prestador', () => {
  const consultas = readProjectFile('services/consultasService.js');
  const pacotes = readProjectFile('services/pacotesService.js');
  const pacotesController = readProjectFile('controllers/pacotesController.js');
  const routesConsultas = readProjectFile('routes/consultas.js');
  const routesPacotes = readProjectFile('routes/pacotes.js');

  assert.match(consultas, /Prestador:\s*prestador,/);
  assert.match(pacotes, /Prestador:\s*prestador,/);
  assert.match(pacotesController, /Prestador:\s*resultado\?\.Prestador\s*\?\?\s*null,/);
  assert.match(routesConsultas, /pre-agendamento\/opcoes-pagamento'[\s\S]*?verificarPermissao\(\['Paciente'\]\)/);
  assert.match(routesPacotes, /pre-compra\/resumo'[\s\S]*?verificarPermissao\(\['Paciente'\]\)/);
});
