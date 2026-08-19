import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CHECKIN_ANTECEDENCIA_MIN } from '../config/consultaRules.js';
import {
  montarEmailCheckinPaciente,
  montarEmailOrientacaoCheckinFisioterapeuta,
  montarEmailNotificacao,
} from '../services/emailTemplates.js';

function source(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('mantém a antecedência operacional e a comunicação em uma única regra', () => {
  assert.equal(CHECKIN_ANTECEDENCIA_MIN, 10);

  const worker = source('workers/orientacaoCheckinFisioWorker.js');
  assert.match(worker, /CHECKIN_ORIENTACAO_MINUTOS_ANTES, 60/);
  assert.match(worker, /CHECKIN_ORIENTACAO_MINIMO_MINUTOS_ANTES,[\s\S]*?50/);
  assert.match(worker, /CHECKIN_ANTECEDENCIA_MIN/);
  assert.match(worker, /tipo: DADOS_TIPO/);
  assert.match(worker, /DADOS_TIPO = 'orientacao_checkin_fisio'/);
});

test('preserva o lembrete de 24h e cria uma função separada para a orientação de check-in', () => {
  const lembrete24h = source('workers/consultasLembretesWorker.js');
  const orientacao = source('workers/orientacaoCheckinFisioWorker.js');
  const functionIndex = source('azure-functions-workers/src/index.js');
  const functionTimer = source(
    'azure-functions-workers/src/functions/enfileirarOrientacaoCheckinFisio.js'
  );

  assert.doesNotMatch(lembrete24h, /checkin_fisio|orientacao_checkin_fisio/);
  assert.match(lembrete24h, /consulta_lembrete_24h/);
  assert.match(orientacao, /chave: 'checkin_fisio'/);
  assert.match(functionIndex, /enfileirarOrientacaoCheckinFisio/);
  assert.match(functionTimer, /schedule: '0 \*\/10 \* \* \* \*'/);
});

test('mapeia exatamente as cinco variáveis do WhatsApp do fisioterapeuta', () => {
  const worker = source('workers/orientacaoCheckinFisioWorker.js');
  assert.match(
    worker,
    /chave: 'checkin_fisio'[\s\S]*?1: primeiroNome\(fisioterapeutaNome[\s\S]*?2: limitarTexto\(pacienteNome\)[\s\S]*?3: data[\s\S]*?4: hora[\s\S]*?5: String\(CHECKIN_ANTECEDENCIA_MIN\)/
  );
});

test('renderiza o e-mail de orientação do fisioterapeuta no padrão FisioHelp', () => {
  const email = montarEmailOrientacaoCheckinFisioterapeuta({
    fisioterapeutaNome: 'Dra. Maria',
    pacienteNome: 'Paula',
    dataConsultaTexto: '20/08/2026',
    horaConsultaTexto: '15:00',
    checkinAntecedenciaMinutos: 10,
  });

  assert.equal(email.assunto, 'Orientações para o check-in da sua consulta');
  assert.match(email.corpoHtml, /Prepare-se para o check-in/);
  assert.match(email.corpoHtml, /Dra\. Maria/);
  assert.match(email.corpoHtml, /20\/08\/2026/);
  assert.match(email.corpoHtml, /solicite o código de validação exibido/);
  assert.match(email.corpoTexto, /Faça o check-in somente depois de chegar ao local/);
  assert.match(email.corpoTexto, /solicite o código de validação exibido/);
  assert.doesNotMatch(email.corpoTexto, /solicite a informação de validação/);
  assert.equal((email.corpoTexto.match(/Mensagem automática/g) || []).length, 1);
});

test('renderiza o e-mail do paciente com a informação de validação sem aceitar HTML', () => {
  const email = montarEmailCheckinPaciente({
    pacienteNome: '<script>Paula</script>',
    fisioterapeutaNome: 'João',
    dataConsultaTexto: '20/08/2026',
    horaConsultaTexto: '15:00',
    tokenValidacao: '483920',
  });

  assert.equal(email.assunto, 'Seu fisioterapeuta chegou para a consulta');
  assert.match(email.corpoHtml, /483920/);
  assert.match(email.corpoTexto, /Informação de validação: 483920/);
  assert.doesNotMatch(email.corpoHtml, /<script>/);
  assert.match(email.corpoHtml, /&lt;script&gt;Paula&lt;\/script&gt;/);
});

test('não coloca um valor arbitrário no lugar da validação da consulta', () => {
  const email = montarEmailCheckinPaciente({ tokenValidacao: '<b>123</b>' });
  assert.match(email.corpoHtml, /Consulte no app/);
  assert.doesNotMatch(email.corpoHtml, /<b>123<\/b>/);
});

test('seleciona os dois novos modelos dedicados pela fila', () => {
  const fisio = montarEmailNotificacao({
    titulo: 'ignorado',
    mensagem: 'ignorada',
    dados: {
      emailModelo: 'orientacao_checkin_fisioterapeuta',
      fisioterapeutaNome: 'Maria',
    },
  });
  const paciente = montarEmailNotificacao({
    titulo: 'ignorado',
    mensagem: 'ignorada',
    dados: {
      emailModelo: 'checkin_paciente',
      pacienteNome: 'Paula',
      tokenValidacao: '123456',
    },
  });

  assert.match(fisio.corpoHtml, /Prepare-se para o check-in/);
  assert.match(paciente.corpoHtml, /123456/);
});

test('o pós-check-in é atômico, idempotente e usa o template aprovado do paciente', () => {
  const consultas = source('services/consultasService.js');
  const dispatch = source('services/notificacoesDispatch.js');
  const notificacoes = source('services/notificacoesService.js');

  assert.match(consultas, /BEGIN TRANSACTION[\s\S]*?SP_GerarTokenValidacaoConsulta[\s\S]*?COMMIT TRANSACTION/);
  assert.match(consultas, /deleted\.CheckinHora IS NULL[\s\S]*?CheckinNovo/);
  assert.match(consultas, /if \(checkinNovo\)[\s\S]*?await notificacoesDispatch\.tokenConsultaGerado/);
  assert.match(dispatch, /canal: 'email'/);
  assert.match(dispatch, /canal: 'whatsapp'/);
  assert.match(dispatch, /chave: 'checkin_paciente'/);
  assert.match(dispatch, /return \/\^\\d\{6\}\$\//);
  assert.match(notificacoes, /TWILIO_WHATSAPP_CONTENT_SID_CHECKIN_FISIO/);
  assert.match(notificacoes, /TWILIO_WHATSAPP_CONTENT_SID_CHECKIN_PACIENTE/);
});
