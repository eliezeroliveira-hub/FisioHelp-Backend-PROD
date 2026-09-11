import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSeoCityPath, buildSeoProfilePath } from '../utils/seoUrl.js';

test('gera URLs SEO de perfil e cidade com acentos normalizados', () => {
  const perfil = { FisioterapeutaId: 80, Nome: 'Lucimar Rosa Félix', Cidade: 'Brasília', Estado: 'DF' };
  assert.equal(buildSeoProfilePath(perfil), '/fisioterapeutas/lucimar-rosa-felix-80/df/brasilia');
  assert.equal(buildSeoCityPath(perfil), '/fisioterapeutas/df/brasilia');
});
