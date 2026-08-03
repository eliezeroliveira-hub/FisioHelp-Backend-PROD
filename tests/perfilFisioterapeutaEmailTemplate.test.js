import test from 'node:test';
import assert from 'node:assert/strict';

import {
  montarEmailLembretePerfilFisioterapeuta,
  PERFIL_FISIOTERAPEUTA_EMAIL_ASSUNTO,
} from '../services/perfilFisioterapeutaEmailTemplate.js';
import { montarEmailNotificacao } from '../services/emailTemplates.js';

test('renderiza o lembrete de perfil com o assunto e o conteúdo aprovados', () => {
  const resultado = montarEmailLembretePerfilFisioterapeuta({
    nomeFisioterapeuta: 'Dayanne Alavarces Fogaça',
  });

  assert.equal(resultado.assunto, 'Seu perfil na FisioHelp está completo?');
  assert.equal(resultado.assunto, PERFIL_FISIOTERAPEUTA_EMAIL_ASSUNTO);
  assert.match(resultado.corpoHtml, /Olá, Dayanne Alavarces Fogaça! Tudo bem\?/);
  assert.match(
    resultado.corpoHtml,
    /Abra o app FisioHelp e complete ou atualize as informações do seu perfil\./
  );
  assert.match(
    resultado.corpoHtml,
    /Mensagem automática — esta caixa não é monitorada\. Fale com suporte@fisiohelp\.com\.br\./
  );
  assert.doesNotMatch(resultado.corpoHtml, /\{\{NOME_FISIOTERAPEUTA\}\}/);
  assert.match(resultado.corpoTexto, /Olá, Dayanne Alavarces Fogaça! Tudo bem\?/);
  assert.match(resultado.corpoTexto, /Abra o app FisioHelp/);
});

test('seleciona o template aprovado pelo emailModelo da fila', () => {
  const resultado = montarEmailNotificacao({
    titulo: 'Título ignorado pelo modelo dedicado',
    mensagem: 'Mensagem ignorada pelo modelo dedicado',
    dados: {
      emailModelo: 'lembrete_perfil_fisioterapeuta',
      fisioterapeutaNome: 'Fisioterapeuta HML',
    },
  });

  assert.equal(resultado.assunto, 'Seu perfil na FisioHelp está completo?');
  assert.match(resultado.corpoHtml, /Olá, Fisioterapeuta HML! Tudo bem\?/);
});
test('escapa o nome antes de inseri-lo no HTML', () => {
  const resultado = montarEmailLembretePerfilFisioterapeuta({
    nomeFisioterapeuta: '<script>alert("x")</script>',
  });

  assert.match(
    resultado.corpoHtml,
    /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/
  );
  assert.doesNotMatch(resultado.corpoHtml, /<script>alert/);
});

test('mantém a estrutura tabular balanceada do HTML', () => {
  const resultado = montarEmailLembretePerfilFisioterapeuta();

  const tabelasAbertas = resultado.corpoHtml.match(/<table\b/g) ?? [];
  const tabelasFechadas = resultado.corpoHtml.match(/<\/table>/g) ?? [];
  const linhasAbertas = resultado.corpoHtml.match(/<tr\b/g) ?? [];
  const linhasFechadas = resultado.corpoHtml.match(/<\/tr>/g) ?? [];

  assert.equal(tabelasAbertas.length, tabelasFechadas.length);
  assert.equal(linhasAbertas.length, linhasFechadas.length);
  assert.match(resultado.corpoHtml, /Olá, fisioterapeuta! Tudo bem\?/);
});