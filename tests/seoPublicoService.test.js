import assert from 'node:assert/strict';
import test from 'node:test';
import { montarCatalogoSeo, validarCatalogoSeo } from '../services/seoPublicoService.js';

test('monta catálogo SEO consistente usando cidade+UF e especialidades distintas', () => {
  const catalogo = montarCatalogoSeo([
    { FisioterapeutaId: 2, Nome: 'Bia', Cidade: 'São Paulo', Estado: 'sp', EspecialidadeNome: 'Ortopedia' },
    { FisioterapeutaId: 1, Nome: 'Ana', Cidade: 'São Paulo', Estado: 'SP', EspecialidadeNome: 'Pediatria' },
    { FisioterapeutaId: 1, Nome: 'Ana', Cidade: 'São Paulo', Estado: 'SP', EspecialidadeNome: 'Ortopedia' },
    { FisioterapeutaId: 1, Nome: 'Ana', Cidade: 'São Paulo', Estado: 'SP', EspecialidadeNome: 'Ortopedia' },
    { FisioterapeutaId: 3, Nome: 'Caio', Cidade: 'São Paulo', Estado: 'MG', EspecialidadeNome: null },
  ], '2026-09-11T12:00:00.000Z');

  assert.deepEqual(catalogo.resumo, {
    fisioterapeutas: 3,
    cidades: 2,
    estados: 2,
    especialidades: 2,
  });
  assert.deepEqual(catalogo.itens.map((item) => item.fisioterapeutaId), [1, 2, 3]);
  assert.deepEqual(catalogo.itens[0].especialidades, ['Ortopedia', 'Pediatria']);
  assert.equal(catalogo.cidades.reduce((total, item) => total + item.quantidade, 0), 3);
  assert.equal(validarCatalogoSeo(catalogo), true);
});

test('falha fechado para perfil órfão ou sem localidade canônica', () => {
  assert.throws(() => montarCatalogoSeo([
    { FisioterapeutaId: 2, Nome: 'Sem cidade', Cidade: '', Estado: 'PE' },
  ]), /perfil público órfão/);
});
