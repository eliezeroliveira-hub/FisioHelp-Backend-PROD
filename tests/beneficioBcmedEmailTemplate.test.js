import assert from 'node:assert/strict';
import test from 'node:test';

import { montarEmailBeneficioBcmedFisioterapeuta } from '../services/beneficioBcmedEmailTemplate.js';
import { montarEmailNotificacao } from '../services/emailTemplates.js';

test('monta lançamento BCMED com links, WhatsApp e sem tokens residuais', () => {
  const email = montarEmailBeneficioBcmedFisioterapeuta({
    nomeFisioterapeuta: 'Ana & Bia',
    variacao: 'lancamento',
  });

  assert.equal(email.assunto, 'Novo benefício FisioHelp: descontos exclusivos na BCMED');
  assert.match(email.corpoHtml, /Ana &amp; Bia/);
  assert.match(email.corpoHtml, /Consultar benefício pelo WhatsApp/);
  assert.equal(
    (email.corpoHtml.match(/https:\/\/www\.bcmed\.com\.br\/fisioterapia/g) || []).length,
    3
  );
  assert.match(email.corpoHtml, /https:\/\/compreno\.link\/FisioHelp/);
  assert.match(email.corpoHtml, /solicite o descadastro/);
  assert.doesNotMatch(email.corpoHtml, /\{\{[^}]+\}\}/);
  assert.doesNotMatch(email.corpoHtml, /🧡 Equipe FisioHelp/);
  assert.equal(email.anexos, undefined);
});

test('monta lembrete autossuficiente para novo elegível', () => {
  const email = montarEmailBeneficioBcmedFisioterapeuta({
    nomeFisioterapeuta: 'Carla',
    variacao: 'lembrete',
  });

  assert.equal(email.assunto, 'Consulte seu benefício FisioHelp na BCMED');
  assert.match(email.corpoTexto, /A parceria entre a FisioHelp e a BCMED oferece/);
  assert.match(email.corpoTexto, /abre uma conversa no WhatsApp/);
});

test('despachante usa o template BCMED em vez do modelo genérico', () => {
  const email = montarEmailNotificacao({
    titulo: 'ignorado',
    mensagem: 'ignorada',
    dados: {
      emailModelo: 'beneficio_bcmed_fisioterapeuta',
      fisioterapeutaNome: 'Daniel',
      variacao: 'lembrete',
    },
  });

  assert.equal(email.assunto, 'Consulte seu benefício FisioHelp na BCMED');
  assert.match(email.corpoHtml, /Daniel/);
});
