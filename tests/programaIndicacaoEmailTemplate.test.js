import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  montarEmailProgramaIndicacaoFisioterapeuta,
  PROGRAMA_INDICACAO_EMAIL_ASSUNTO_LANCAMENTO,
  PROGRAMA_INDICACAO_EMAIL_ASSUNTO_MENSAL,
} from '../services/programaIndicacaoEmailTemplate.js';
import { montarEmailNotificacao } from '../services/emailTemplates.js';

test('renderiza o e-mail inaugural com formulário, termos e imagem inline', () => {
  const resultado = montarEmailProgramaIndicacaoFisioterapeuta({
    nomeFisioterapeuta: 'Fisioterapeuta HML',
    variacao: 'lancamento',
  });

  assert.equal(resultado.assunto, PROGRAMA_INDICACAO_EMAIL_ASSUNTO_LANCAMENTO);
  assert.match(resultado.corpoHtml, /Olá, Fisioterapeuta HML! 🧡/);
  assert.match(resultado.corpoHtml, /docs\.google\.com\/forms/);
  assert.match(resultado.corpoHtml, /drive\.google\.com\/file/);
  assert.match(resultado.corpoHtml, /cid:fisiohelp_programa_indicacao/);
  assert.match(
    resultado.corpoHtml,
    /cada indicação recebe o valor correspondente à faixa em que foi aprovada/
  );
  assert.doesNotMatch(resultado.corpoHtml, /\{\{(?:NOME|PREHEADER|ABERTURA)/);
  assert.equal(resultado.anexos.length, 1);
  assert.equal(resultado.anexos[0].contentId, 'fisiohelp_programa_indicacao');
  assert.equal(resultado.anexos[0].contentType, 'image/png');
  assert.ok(resultado.anexos[0].contentInBase64.length > 100_000);
});

test('renderiza a variação mensal com o gancho de reinício das faixas', () => {
  const resultado = montarEmailProgramaIndicacaoFisioterapeuta({
    nomeFisioterapeuta: 'Fisio Mensal',
    variacao: 'mensal',
  });

  assert.equal(resultado.assunto, PROGRAMA_INDICACAO_EMAIL_ASSUNTO_MENSAL);
  assert.match(resultado.corpoHtml, /As faixas voltaram a zero com o início do novo mês/);
  assert.match(resultado.corpoTexto, /As faixas voltaram a zero/);
});

test('seleciona o modelo dedicado pela fila e escapa o nome', () => {
  const resultado = montarEmailNotificacao({
    titulo: 'Título ignorado',
    mensagem: 'Mensagem ignorada',
    dados: {
      emailModelo: 'programa_indicacao_fisioterapeuta',
      fisioterapeutaNome: '<script>alert("x")</script>',
      variacao: 'lancamento',
    },
  });

  assert.equal(resultado.assunto, PROGRAMA_INDICACAO_EMAIL_ASSUNTO_LANCAMENTO);
  assert.match(
    resultado.corpoHtml,
    /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/
  );
  assert.doesNotMatch(resultado.corpoHtml, /<script>alert/);
});

test('mantém tabelas e linhas balanceadas no HTML final', () => {
  const resultado = montarEmailProgramaIndicacaoFisioterapeuta();

  assert.equal(
    (resultado.corpoHtml.match(/<table\b/g) ?? []).length,
    (resultado.corpoHtml.match(/<\/table>/g) ?? []).length
  );
  assert.equal(
    (resultado.corpoHtml.match(/<tr\b/g) ?? []).length,
    (resultado.corpoHtml.match(/<\/tr>/g) ?? []).length
  );
});

test('o provider e o processador preservam os anexos inline do template', () => {
  const providerSource = readFileSync(
    new URL('../providers/emailProvider.js', import.meta.url),
    'utf8'
  );
  const serviceSource = readFileSync(
    new URL('../services/notificacoesService.js', import.meta.url),
    'utf8'
  );

  assert.match(providerSource, /attachments:/);
  assert.match(providerSource, /contentId/);
  assert.match(serviceSource, /anexos: template\.anexos/);
});