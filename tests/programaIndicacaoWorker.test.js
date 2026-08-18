import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  obterCompetenciaBrasil,
  resolverExecucaoCampanha,
} from '../utils/programaIndicacaoCompetencia.js';

test('resolve a competência pelo horário de São Paulo', () => {
  assert.equal(
    obterCompetenciaBrasil(new Date('2026-09-01T02:30:00.000Z')),
    '2026-08'
  );
  assert.equal(
    obterCompetenciaBrasil(new Date('2026-09-01T03:30:00.000Z')),
    '2026-09'
  );
});

test('permite o lançamento fora do primeiro dia somente para a competência configurada', () => {
  const lancamento = resolverExecucaoCampanha({
    agora: new Date('2026-08-18T15:00:00.000Z'),
    lancamentoCompetencia: '2026-08',
  });
  assert.equal(lancamento.executar, true);
  assert.equal(lancamento.variacao, 'lancamento');

  const bloqueado = resolverExecucaoCampanha({
    agora: new Date('2026-08-18T15:00:00.000Z'),
    lancamentoCompetencia: null,
  });
  assert.equal(bloqueado.executar, false);
});

test('executa a recorrência mensal apenas no primeiro dia em São Paulo', () => {
  const mensal = resolverExecucaoCampanha({
    agora: new Date('2026-09-01T12:00:00.000Z'),
    lancamentoCompetencia: '2026-08',
  });
  assert.equal(mensal.executar, true);
  assert.equal(mensal.variacao, 'mensal');
  assert.equal(mensal.competencia, '2026-09');
});

test('mantém elegibilidade, deduplicação por competência e push aprovados no código', () => {
  const source = readFileSync(
    new URL('../workers/programaIndicacaoFisioterapeutaWorker.js', import.meta.url),
    'utf8'
  );
  const functionSource = readFileSync(
    new URL(
      '../azure-functions-workers/src/functions/enfileirarProgramaIndicacaoFisioterapeuta.js',
      import.meta.url
    ),
    'utf8'
  );

  assert.match(source, /ISNULL\(f\.Ativo, 0\) = 1/);
  assert.match(source, /ISNULL\(f\.IsBloqueado, 0\) = 0/);
  assert.match(source, /ISNULL\(f\.CrefitoVerificado, 0\) = 1/);
  assert.match(source, /ISNULL\(f\.EmailVerificado, 0\) = 1/);
  assert.match(source, /dbo\.EmailSupressao/);
  assert.match(source, /dbo\.DispositivosNotificacao/);
  assert.match(source, /JSON_VALUE\(fn\.DadosJson, '\$\.competencia'\)/);
  assert.match(source, /sys\.sp_getapplock/);
  assert.match(
    source,
    /resolverExecucaoCampanha\(\{\s*lancamentoCompetencia: config\.lancamentoCompetencia/
  );
  assert.match(
    source,
    /Indique fisioterapeutas e ganhe\. Saiba mais no e-mail que enviamos à você/
  );
  assert.match(functionSource, /schedule: '0 0 12 1 \* \*'/);
  assert.match(functionSource, /runOnStartup: true/);
});