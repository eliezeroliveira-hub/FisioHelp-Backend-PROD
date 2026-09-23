import assert from 'node:assert/strict';
import test from 'node:test';

import { montarEmailBeneficioJalecosConfortoFisioterapeuta } from '../services/beneficioJalecosConfortoEmailTemplate.js';
import { montarEmailNotificacao } from '../services/emailTemplates.js';

test('monta lançamento Jalecos com links, cupom e sem tokens residuais', () => {
  const email = montarEmailBeneficioJalecosConfortoFisioterapeuta({
    nomeFisioterapeuta: 'Ana & Bia',
    variacao: 'lancamento',
  });

  assert.equal(email.assunto, '🧡 Novo benefício FisioHelp: 10% OFF na Jalecos Conforto');
  assert.match(email.corpoHtml, /Ana &amp; Bia/);
  assert.equal(
    (email.corpoHtml.match(/https:\/\/www\.jalecosconforto\.com\.br\//g) || []).length,
    5
  );
  assert.equal((email.corpoHtml.match(/FisioHelp/g) || []).length >= 5, true);
  assert.match(email.corpoHtml, /Quero aproveitar meus 10% OFF/);
  assert.match(email.corpoHtml, /solicite o descadastro/);
  assert.doesNotMatch(email.corpoHtml, /\{\{[^}]+\}\}/);
  assert.doesNotMatch(email.corpoHtml, /Protótipo visual/);
  assert.equal(email.anexos, undefined);
});

test('monta lembrete autossuficiente para novo elegível', () => {
  const email = montarEmailBeneficioJalecosConfortoFisioterapeuta({
    nomeFisioterapeuta: 'Carla',
    variacao: 'lembrete',
  });

  assert.equal(email.assunto, 'Seu cupom de 10% OFF na Jalecos Conforto');
  assert.match(email.corpoTexto, /A parceria entre a FisioHelp e a Jalecos Conforto oferece/);
  assert.match(email.corpoTexto, /Cupom: FisioHelp/);
});

test('despachante usa o template Jalecos em vez do modelo genérico', () => {
  const email = montarEmailNotificacao({
    titulo: 'ignorado',
    mensagem: 'ignorada',
    dados: {
      emailModelo: 'beneficio_jalecos_conforto_fisioterapeuta',
      fisioterapeutaNome: 'Daniel',
      variacao: 'lembrete',
      beneficioUrl: 'https://www.jalecosconforto.com.br/',
      cupom: 'FisioHelp',
    },
  });

  assert.equal(email.assunto, 'Seu cupom de 10% OFF na Jalecos Conforto');
  assert.match(email.corpoHtml, /Daniel/);
});

test('template rejeita URL e cupom fora da configuração aprovada', () => {
  assert.throws(
    () => montarEmailBeneficioJalecosConfortoFisioterapeuta({
      beneficioUrl: 'https://example.com/',
    }),
    /URL do benefício/
  );
  assert.throws(
    () => montarEmailBeneficioJalecosConfortoFisioterapeuta({ cupom: '<script>' }),
    /Cupom do benefício/
  );
});
