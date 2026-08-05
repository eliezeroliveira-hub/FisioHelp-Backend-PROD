import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { montarNotificacoesCrefitoReprovado } from '../services/crefitoReprovadoNotification.js';
import { montarEmailNotificacao } from '../services/emailTemplates.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

test('monta push, inbox e e-mail com motivo e referências do documento', () => {
  const notificacoes = montarNotificacoesCrefitoReprovado({
    fisioterapeutaId: 59,
    fisioterapeutaNome: 'Fisioterapeuta Teste',
    documentoId: 321,
    motivo: 'Imagem ilegível. Envie uma foto com melhor iluminação.',
  });

  assert.deepEqual(notificacoes.destinatario, {
    usuarioTipo: 'Fisioterapeuta',
    usuarioId: 59,
  });
  assert.equal(notificacoes.push.tipo, 'Credenciamento');
  assert.equal(notificacoes.push.titulo, 'CREFITO precisa de correção');
  assert.match(notificacoes.push.mensagem, /Motivo: Imagem ilegível/);
  assert.match(notificacoes.push.mensagem, /envie novamente pelo app/);
  assert.equal(notificacoes.push.referenciaId, 321);
  assert.equal(notificacoes.push.dados.tipo, 'crefito_reprovado');
  assert.equal(notificacoes.push.dados.motivoRejeicao, 'Imagem ilegível. Envie uma foto com melhor iluminação.');

  assert.equal(notificacoes.email.titulo, 'Seu CREFITO precisa de correção');
  assert.equal(notificacoes.email.dados.emailModelo, 'crefito_reprovado');
  assert.equal(notificacoes.email.dados.fisioterapeutaNome, 'Fisioterapeuta Teste');
  assert.equal(notificacoes.email.dados.motivoRejeicao, notificacoes.push.dados.motivoRejeicao);
});

test('limita mensagem push sem perder o motivo completo usado pelo e-mail', () => {
  const motivo = 'A'.repeat(500);
  const notificacoes = montarNotificacoesCrefitoReprovado({
    fisioterapeutaId: 59,
    fisioterapeutaNome: 'Fisioterapeuta Teste',
    documentoId: 321,
    motivo,
  });

  assert.ok(notificacoes.push.mensagem.length <= 500);
  assert.equal(notificacoes.push.dados.motivoRejeicao.length, 500);
  assert.equal(notificacoes.email.dados.motivoRejeicao, motivo);
});

test('rejeita dispatch sem motivo ou identificadores válidos', () => {
  assert.throws(
    () => montarNotificacoesCrefitoReprovado({
      fisioterapeutaId: 59,
      documentoId: 321,
      motivo: '   ',
    }),
    /Motivo de reprovação é obrigatório/
  );
  assert.throws(
    () => montarNotificacoesCrefitoReprovado({
      fisioterapeutaId: 0,
      documentoId: 321,
      motivo: 'Documento inválido',
    }),
    /FisioterapeutaId inválido/
  );
});

test('template de e-mail inclui motivo completo, instrução e rodapé padrão', () => {
  const email = montarEmailNotificacao({
    titulo: 'ignorado pelo modelo',
    mensagem: 'ignorada pelo modelo',
    dados: {
      emailModelo: 'crefito_reprovado',
      fisioterapeutaNome: 'Maria da Silva',
      motivoRejeicao: 'Documento cortado <reenvie> & confirme.',
    },
  });

  assert.equal(email.assunto, 'Seu CREFITO precisa de correção');
  assert.match(email.corpoHtml, /Olá, Maria/);
  assert.match(email.corpoHtml, /Documento cortado &lt;reenvie&gt; &amp; confirme./);
  assert.doesNotMatch(email.corpoHtml, /Documento cortado <reenvie>/);
  assert.match(email.corpoHtml, /encaminhe para o e-mail suporte@fisiohelp\.com\.br/);
  assert.match(email.corpoHtml, /número correto e completo do seu registro profissional/);
  assert.match(email.corpoHtml, /emitida pelo CREFITO-2/);
  assert.match(email.corpoHtml, /Caso o registro seja de outro Conselho Regional/);
  assert.match(email.corpoHtml, /Assim que recebermos as informações atualizadas/);
  assert.match(email.corpoHtml, /Atenciosamente,<br>Equipe FisioHelp/);
  assert.doesNotMatch(email.corpoHtml, /faça um novo envio para análise/);
  assert.match(email.corpoTexto, /Documento cortado <reenvie> & confirme./);
  assert.match(email.corpoTexto, /suporte@fisiohelp\.com\.br/);
  assert.match(email.corpoTexto, /- O número correto e completo/);
  assert.match(email.corpoTexto, /Atenciosamente,\nEquipe FisioHelp/);
  assert.match(email.corpoTexto, /Mensagem automática — esta caixa não é monitorada/);
});

test('dispatch usa push com inbox e e-mail separado', () => {
  const source = fs.readFileSync(
    path.resolve(currentDir, '../services/notificacoesDispatch.js'),
    'utf8'
  );
  const inicio = source.indexOf('async function crefitoReprovado');
  const fim = source.indexOf('const notificacoesDispatch', inicio);
  const bloco = inicio >= 0 && fim > inicio ? source.slice(inicio, fim) : '';

  assert.ok(bloco.includes("safeDispatch('crefitoReprovado'"));
  assert.ok(bloco.includes('montarNotificacoesCrefitoReprovado'));
  assert.ok(bloco.includes('enfileirarPushEEmail'));
  assert.ok(bloco.includes('emailNotificacao: notificacoes.email'));
  assert.ok(!bloco.includes('gravarInbox: false'));
});

test('Admin dispara somente após transição idempotente confirmada pelo SQL', () => {
  const source = fs.readFileSync(
    path.resolve(currentDir, '../services/adminService.js'),
    'utf8'
  );
  const inicio = source.indexOf("if (status === 'Reprovado')");
  const fim = source.indexOf('// Outros status', inicio);
  const bloco = inicio >= 0 && fim > inicio ? source.slice(inicio, fim) : '';

  assert.ok(bloco.includes('DECLARE @TransicaoReprovado BIT = 0'));
  assert.ok(bloco.includes("LTRIM(RTRIM(ISNULL(Status, N''))) <> @Status"));
  assert.ok(bloco.includes('SELECT @TransicaoReprovado AS TransicaoReprovado'));
  assert.ok(bloco.includes('if (!houveTransicao)'));
  assert.ok(bloco.includes('Nenhuma nova notificação foi enviada'));
  assert.ok(bloco.includes('notificacoesDispatch.crefitoReprovado'));

  const commitIndex = bloco.indexOf('COMMIT;');
  const dispatchIndex = bloco.indexOf('notificacoesDispatch.crefitoReprovado');
  assert.ok(commitIndex >= 0 && dispatchIndex > commitIndex, 'dispatch deve ocorrer depois do COMMIT');
});
