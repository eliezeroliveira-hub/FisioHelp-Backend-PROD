import test from 'node:test';
import assert from 'node:assert/strict';

import { montarEmailConvitePreCadastroSimples } from '../services/contatoTemplates.js';

const APP_STORE_URL = 'https://apps.apple.com/br/app/fisiohelp/id6794336661';
const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=br.com.fisiohelp.app';

test('mantém o assunto do convite e inclui os links das lojas no HTML e no texto', () => {
  const resultado = montarEmailConvitePreCadastroSimples({
    nomePaciente: 'Maria da Silva',
    nomeFisioterapeuta: 'João Souza',
  });

  assert.equal(
    resultado.assunto,
    'João Souza convidou você para acessar a FisioHelp'
  );

  assert.match(resultado.corpoHtml, /Olá, Maria,/);
  assert.match(resultado.corpoHtml, /Baixar na App Store/);
  assert.match(resultado.corpoHtml, /Baixar no Google Play/);
  assert.ok(resultado.corpoHtml.includes(APP_STORE_URL));
  assert.ok(resultado.corpoHtml.includes(GOOGLE_PLAY_URL));

  assert.ok(resultado.corpoTexto.includes(`App Store: ${APP_STORE_URL}`));
  assert.ok(resultado.corpoTexto.includes(`Google Play: ${GOOGLE_PLAY_URL}`));
  assert.match(
    resultado.corpoTexto,
    /Já fui pré-cadastrado por um fisioterapeuta/
  );
});

test('escapa os nomes inseridos no HTML do convite', () => {
  const resultado = montarEmailConvitePreCadastroSimples({
    nomePaciente: '<script>alert("paciente")</script>',
    nomeFisioterapeuta: '<b>Fisio</b>',
  });

  assert.doesNotMatch(resultado.corpoHtml, /<script>alert/);
  assert.doesNotMatch(resultado.corpoHtml, /<b>Fisio<\/b>/);
  assert.match(resultado.corpoHtml, /&lt;script&gt;/);
  assert.match(resultado.corpoHtml, /&lt;b&gt;Fisio&lt;\/b&gt;/);
});
