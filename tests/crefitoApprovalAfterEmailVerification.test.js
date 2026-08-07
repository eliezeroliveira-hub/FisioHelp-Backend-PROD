import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const v133 = fs.readFileSync(
  new URL('../sql/FISIOTERAPEUTA_CREFITO_EMAIL_REENVIO_V133.sql', import.meta.url),
  'utf8'
);
const fisioterapeutasService = fs.readFileSync(
  new URL('../services/fisioterapeutasService.js', import.meta.url),
  'utf8'
);
const redefinicaoSenhaService = fs.readFileSync(
  new URL('../services/redefinicaoSenhaService.js', import.meta.url),
  'utf8'
);
const verificacaoContatoService = fs.readFileSync(
  new URL('../services/verificacaoContatoService.js', import.meta.url),
  'utf8'
);
const dispatch = fs.readFileSync(
  new URL('../services/notificacoesDispatch.js', import.meta.url),
  'utf8'
);

test('V133 cria procedure idempotente sem transação própria', () => {
  const start = v133.indexOf('CREATE OR ALTER PROCEDURE dbo.SP_Fisio_ReenfileirarCrefitoAprovadoSeElegivel');
  const end = v133.indexOf("END;'", start);
  const block = v133.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(block, /IF @@TRANCOUNT = 0/);
  assert.doesNotMatch(block, /BEGIN TRAN(?:SACTION)?\s*;/);
  assert.match(block, /Fisioterapeutas WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(block, /FilaNotificacoes WITH \(UPDLOCK, HOLDLOCK\)/);
});

test('reenfileiramento só ocorre para fisioterapeuta plenamente elegível', () => {
  assert.match(v133, /@Ativo <> 1/);
  assert.match(v133, /@IsBloqueado <> 0/);
  assert.match(v133, /@CrefitoVerificado <> 1/);
  assert.match(v133, /@EmailVerificado <> 1/);
});

test('V133 evita duplicidade e reaproveita a falha por e-mail não verificado', () => {
  assert.match(v133, /Status = N''Enviado''/);
  assert.match(v133, /Status IN \(N''Pendente'', N''Processando'', N''FalhaTemporaria''\)/);
  assert.match(v133, /Status = N''FalhaDefinitiva''/);
  assert.match(v133, /N''e-mail não verificado''/);
  assert.match(v133, /Status = N''Pendente''/);
  assert.match(v133, /Tentativas = 0/);
  assert.match(v133, /ProcessandoEm = NULL/);
  assert.match(v133, /UltimoErro = NULL/);
});

test('procedure não emite result set que interfira no retorno da confirmação', () => {
  const start = v133.indexOf('CREATE OR ALTER PROCEDURE dbo.SP_Fisio_ReenfileirarCrefitoAprovadoSeElegivel');
  const end = v133.indexOf("END;'", start);
  const block = v133.slice(start, end);

  assert.doesNotMatch(block, /\bAS Acao\b/);
  assert.doesNotMatch(block, /\bSELECT\s+N''(?:NaoElegivel|JaEnviada|JaPendente|Reenfileirada|Criada)''/);
});

test('confirmação de contato chama a procedure após marcar o e-mail', () => {
  const start = fisioterapeutasService.indexOf('DECLARE @ConfirmadoAgora BIT = 0');
  const end = fisioterapeutasService.indexOf('COMMIT;', start);
  const block = fisioterapeutasService.slice(start, end);

  const updateIndex = block.indexOf('SET EmailVerificado = 1');
  const procedureIndex = block.indexOf('SP_Fisio_ReenfileirarCrefitoAprovadoSeElegivel');
  assert.ok(updateIndex >= 0 && procedureIndex > updateIndex);
});

test('cadastro solicita verificação com contexto do próprio fisioterapeuta', () => {
  const start = fisioterapeutasService.indexOf('await solicitarVerificacaoContatoInterna({');
  const end = fisioterapeutasService.indexOf('})', start);
  const block = fisioterapeutasService.slice(start, end);

  assert.ok(start >= 0);
  assert.doesNotMatch(fisioterapeutasService, /void solicitarVerificacaoContatoInterna\(\{/);
  assert.match(block, /usuarioTipo: 'Fisioterapeuta'/);
  assert.match(block, /usuarioId: novoId/);
  assert.match(block, /usuario: \{ id: novoId, tipo: 'Fisioterapeuta' \}/);
  assert.match(fisioterapeutasService, /fisioterapeutaId: novoId/);
  assert.match(fisioterapeutasService, /fisio\.verificacaoEmailEnviada = true/);
});

test('serviço usa o contexto recebido também para localizar o contato protegido por RLS', () => {
  const searchStart = verificacaoContatoService.indexOf('async function buscarUsuarioContato');
  const searchEnd = verificacaoContatoService.indexOf('\n}', searchStart);
  const searchBlock = verificacaoContatoService.slice(searchStart, searchEnd);
  const callStart = verificacaoContatoService.indexOf('const usuarioContato = await buscarUsuarioContato');
  const callEnd = verificacaoContatoService.indexOf('});', callStart);
  const callBlock = verificacaoContatoService.slice(callStart, callEnd);

  assert.match(searchBlock, /usuario = null/);
  assert.match(searchBlock, /queryWithContext\(\s*usuario,/);
  assert.match(callBlock, /usuario,/);
});

test('redefinição por e-mail também chama a procedure dentro da transação', () => {
  const start = redefinicaoSenhaService.indexOf('SET XACT_ABORT ON;', redefinicaoSenhaService.indexOf('const tabela'));
  const end = redefinicaoSenhaService.indexOf('COMMIT;', start);
  const block = redefinicaoSenhaService.slice(start, end);

  assert.match(block, /@UsuarioTipo = N'Fisioterapeuta' AND @Canal = N'Email'/);
  assert.match(block, /SP_Fisio_ReenfileirarCrefitoAprovadoSeElegivel/);
  assert.ok(block.indexOf('SP_Fisio_ReenfileirarCrefitoAprovadoSeElegivel') < block.indexOf('UPDATE dbo.RefreshTokens'));
});

test('aprovação não enfileira e-mail condenado quando o contato não está verificado', () => {
  const summaryStart = dispatch.indexOf('async function buscarFisioterapeutaResumo');
  const summaryEnd = dispatch.indexOf('async function jaExisteChatRecente', summaryStart);
  const summaryBlock = dispatch.slice(summaryStart, summaryEnd);
  const approvalStart = dispatch.indexOf('async function crefitoAprovado');
  const approvalEnd = dispatch.indexOf('async function crefitoReprovado', approvalStart);
  const approvalBlock = dispatch.slice(approvalStart, approvalEnd);

  assert.match(summaryBlock, /EmailVerificado/);
  assert.match(summaryBlock, /CrefitoVerificado/);
  assert.match(approvalBlock, /if \(emailVerificado\)/);
  assert.match(approvalBlock, /Confirme seu e-mail para liberar seu perfil para agendamentos/);
  assert.match(approvalBlock, /\{ canal: 'email', gravarInbox: false \}/);
});
