import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('orienta o fisioterapeuta sobre o cancelamento automático nos avisos de nova consulta e reagendamento', () => {
  const dispatch = source('services/notificacoesDispatch.js');
  const orientacao =
    'Se a consulta permanecer sem confirmação quando faltarem 2 horas para o horário agendado, ela será cancelada automaticamente.';
  const consultaAgendada = dispatch.slice(
    dispatch.indexOf('async function consultaAgendada'),
    dispatch.indexOf('async function consultaConfirmada')
  );
  const consultaReagendada = dispatch.slice(
    dispatch.indexOf('async function consultaReagendada'),
    dispatch.indexOf('async function tokenConsultaGerado')
  );

  assert.match(consultaAgendada, /usuarioTipo: 'Fisioterapeuta'/);
  assert.match(consultaAgendada, /titulo: 'Nova consulta'/);
  assert.equal(
    (consultaAgendada.match(/ORIENTACAO_CANCELAMENTO_SEM_CONFIRMACAO/g) || []).length,
    2
  );
  assert.match(consultaReagendada, /usuarioTipo: 'Fisioterapeuta'/);
  assert.match(consultaReagendada, /titulo: 'Consulta reagendada'/);
  assert.equal(
    (consultaReagendada.match(/ORIENTACAO_CANCELAMENTO_SEM_CONFIRMACAO/g) || []).length,
    1
  );
  assert.ok(dispatch.includes(orientacao));
});

test('preserva os três canais do lembrete de consulta de 24 horas', () => {
  const worker = source('workers/consultasLembretesWorker.js');
  const timer = source('azure-functions-workers/src/functions/enfileirarLembretesConsulta.js');

  assert.match(worker, /canais\.push\('push'\)/);
  assert.match(worker, /canais\.push\('email'\)/);
  assert.match(worker, /canais\.push\('whatsapp'\)/);
  assert.match(worker, /chave: 'lembrete_consulta_24h'/);
  assert.match(timer, /schedule: '0 \*\/10 \* \* \* \*'/);
});
