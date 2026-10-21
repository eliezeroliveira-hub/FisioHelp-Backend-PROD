import assert from 'node:assert/strict';
import test from 'node:test';

import { montarEmailPacientePrimeiraConsulta } from '../services/pacientePrimeiraConsultaEmailTemplate.js';
import { montarEmailNotificacao } from '../services/emailTemplates.js';

test('monta e-mail com primeiro nome, tutorial completo e links', () => {
  const email = montarEmailPacientePrimeiraConsulta({
    nomePaciente: 'Ana & Silva',
  });

  assert.equal(
    email.assunto,
    'Sua conta está pronta. Que tal encontrar seu fisioterapeuta?'
  );
  assert.ok(email.corpoHtml.includes('Olá, <strong>Ana</strong>!'));
  assert.doesNotMatch(email.corpoHtml, /Silva/);
  assert.match(email.corpoHtml, /sumário do contrato/);
  assert.match(email.corpoHtml, /No site ou no app/);
  assert.match(email.corpoHtml, /youtube\.com\/shorts\/p7bcIv3_qJ4/);
  assert.match(email.corpoHtml, /apps\.apple\.com/);
  assert.match(email.corpoHtml, /play\.google\.com/);
  assert.match(email.corpoHtml, /67\.039\.614\/0001-58/);
  assert.match(email.corpoHtml, /solicite o descadastro/);
  assert.doesNotMatch(email.corpoHtml, /\{\{[^}]+\}\}/);
});

test('usa saudação segura quando o paciente não tem nome', () => {
  const email = montarEmailPacientePrimeiraConsulta({ nomePaciente: '   ' });
  assert.match(email.corpoHtml, />Olá! 👋</);
  assert.match(email.corpoTexto, /^Sua fisioterapia[\s\S]*\nOlá!\n/);
  assert.doesNotMatch(email.corpoHtml, /NOME_PACIENTE/);
});

test('despachante seleciona o template de ativação', () => {
  const email = montarEmailNotificacao({
    titulo: 'ignorado',
    mensagem: 'ignorada',
    dados: {
      emailModelo: 'ativacao_primeira_consulta_paciente',
      pacienteNome: 'Bruno Teste',
    },
  });
  assert.match(email.corpoHtml, /<strong>Bruno<\/strong>/);
  assert.match(email.corpoTexto, /Encontrar um fisioterapeuta/);
});

test('rejeita links fora dos hosts aprovados', () => {
  assert.throws(
    () => montarEmailPacientePrimeiraConsulta({
      videoUrl: 'https://example.com/video',
    }),
    /videoUrl/
  );
});
