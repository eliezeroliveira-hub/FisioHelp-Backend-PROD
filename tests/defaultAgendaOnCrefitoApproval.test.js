import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ROTINA_PADRAO_AUTO,
  rotinaPadraoHoraSql,
} from '../config/agendaDefaults.js';

test('rotina padrão é segunda a sexta, das 08h às 18h e ativa', () => {
  assert.deepEqual(ROTINA_PADRAO_AUTO.diasSemana, [1, 2, 3, 4, 5]);
  assert.equal(ROTINA_PADRAO_AUTO.horaInicio, '08:00');
  assert.equal(ROTINA_PADRAO_AUTO.horaFim, '18:00');
  assert.equal(ROTINA_PADRAO_AUTO.ativo, 1);
  assert.equal(ROTINA_PADRAO_AUTO.notas, null);
  assert.equal(Object.isFrozen(ROTINA_PADRAO_AUTO), true);
  assert.equal(Object.isFrozen(ROTINA_PADRAO_AUTO.diasSemana), true);
});

test('horários padrão são convertidos para o tipo TIME do driver SQL', () => {
  const inicio = rotinaPadraoHoraSql(ROTINA_PADRAO_AUTO.horaInicio);
  const fim = rotinaPadraoHoraSql(ROTINA_PADRAO_AUTO.horaFim);

  assert.equal(inicio.toISOString(), '1970-01-01T08:00:00.000Z');
  assert.equal(fim.toISOString(), '1970-01-01T18:00:00.000Z');
  assert.throws(() => rotinaPadraoHoraSql('25:00'), /Horário da rotina padrão inválido/);
});

test('aprovação do CREFITO garante rotina dentro da mesma transação', () => {
  const source = fs.readFileSync(new URL('../services/adminService.js', import.meta.url), 'utf8');
  const start = source.indexOf("if (status === 'Aprovado')");
  const end = source.indexOf("if (status === 'Reprovado')", start);
  const block = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(block, /AgendasFisioterapeutas WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(block, /IF NOT EXISTS/);
  assert.match(block, /INSERT INTO dbo\.AgendasFisioterapeutas/);
  assert.match(block, /ROTINA_PADRAO_APROVACAO_VALUES_SQL/);
  assert.match(block, /SET @AgendasCriadas = @@ROWCOUNT/);
  assert.match(block, /@AgendasCriadas <> @QuantidadeAgendaEsperada/);
  assert.match(block, /SELECT @AgendasCriadas AS AgendasCriadas/);

  const insertIndex = block.indexOf('INSERT INTO dbo.AgendasFisioterapeutas');
  const commitIndex = block.indexOf('COMMIT;');
  assert.ok(insertIndex >= 0 && commitIndex > insertIndex);
});

test('reprovação do CREFITO não cria rotina', () => {
  const source = fs.readFileSync(new URL('../services/adminService.js', import.meta.url), 'utf8');
  const start = source.indexOf("if (status === 'Reprovado')");
  const end = source.indexOf("if (status === 'Pendente')", start);
  const block = source.slice(start, end >= 0 ? end : undefined);

  assert.ok(start >= 0);
  assert.doesNotMatch(block, /INSERT INTO dbo\.AgendasFisioterapeutas/);
});

test('fallback ao abrir a Agenda continua idempotente e documentado corretamente', () => {
  const source = fs.readFileSync(new URL('../services/agendaService.js', import.meta.url), 'utf8');
  const calls = source.match(/await ensureRotinaPadraoSeVazia\(/g) ?? [];

  assert.equal(calls.length, 3);
  assert.match(source, /1\.\.5, segunda a sexta/);
  assert.match(source, /AgendasFisioterapeutas WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(source, /ROTINA_PADRAO_VALUES_SQL/);
});
