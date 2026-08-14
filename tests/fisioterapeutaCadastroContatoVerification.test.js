import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function source(relative) {
  return fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
}

const migration = source('sql/FISIOTERAPEUTA_CADASTRO_CONTATO_VERIFICACAO_V135.sql');
const cadastroService = source('services/fisioterapeutaCadastroContatoService.js');
const fisioterapeutasService = source('services/fisioterapeutasService.js');
const filaService = source('services/contatoFilaService.js');
const cadastroRoutes = source('routes/cadastro.js');
const limiter = source('middleware/apiLimiter.js');
const env = source('config/env.js');
const jobsPackage = source('azure-functions/package.json');
const cleanupJob = source('azure-functions/src/functions/limparCadastrosFisioPendentes.js');

test('V135 cria sessão, verificações por canal e procedure de limpeza idempotente', () => {
  assert.match(migration, /FisioterapeutaCadastroSessoes/);
  assert.match(migration, /FisioterapeutaCadastroVerificacoes/);
  assert.match(migration, /UNIQUE \(CadastroSessaoId, Canal\)/);
  assert.match(migration, /Canal IN \(N'Email', N'Telefone'\)/);
  assert.match(migration, /CREATE OR ALTER PROCEDURE dbo\.SP_LimparCadastrosFisioPendentes/);
});

test('códigos usam hash HMAC, salt aleatório, comparação segura e não são persistidos na sessão', () => {
  assert.match(cadastroService, /crypto\.randomBytes\(16\)/);
  assert.match(cadastroService, /createHmac\('sha256', getContatoSecret\(\)\)/);
  assert.match(cadastroService, /crypto\.timingSafeEqual/);
  assert.doesNotMatch(migration, /Codigo\s+NVARCHAR/);
});

test('prova fica vinculada à sessão, CREFITO, e-mail e telefone', () => {
  assert.match(cadastroService, /fisio-cadastro-contato:v1:/);
  assert.match(cadastroService, /email: emailNorm/);
  assert.match(cadastroService, /telefone: telefoneNorm/);
  assert.match(cadastroService, /crefito: crefitoNorm/);
});

test('criação consome a sessão na mesma transação e grava os dois contatos verificados', () => {
  const criar = fisioterapeutasService.slice(fisioterapeutasService.indexOf('async criar'));
  const begin = criar.search(/BEGIN TRY\r?\n\s+BEGIN TRAN;/);
  const commit = criar.indexOf('COMMIT;', begin);
  assert.ok(begin >= 0, 'bloco transacional do cadastro não localizado');
  assert.ok(commit > begin, 'commit do cadastro não localizado');
  const block = criar.slice(begin, commit);
  assert.match(block, /WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(block, /EmailVerificado, EmailVerificadoEm/);
  assert.match(block, /TelefoneVerificado, TelefoneVerificadoEm/);
  assert.match(block, /Status = N'Consumido'/);
  assert.match(block, /FisioterapeutaId = @FisioId/);
});

test('cadastro público sempre devolve Id mesmo quando o perfil completo usa FisioterapeutaId', () => {
  assert.match(
    fisioterapeutasService,
    /fisio\.Id = Number\(fisio\.Id \?\? fisio\.FisioterapeutaId \?\? novoId\)/
  );
});

test('env valida modos de rollout e o fluxo novo não envia e-mail pós-criação', () => {
  assert.match(env, /FISIO_CADASTRO_CONTATO_PREVALIDACAO_MODE/);
  assert.match(env, /\['optional', 'required'\]/);
  assert.match(env, /FISIO_LOGIN_CONTATO_GATE_MODE/);
  assert.match(fisioterapeutasService, /if \(!contatosPrevalidados\)/);
});

test('endpoints públicos têm limites por IP, e-mail normalizado e telefone normalizado', () => {
  assert.match(cadastroRoutes, /cadastroFisioContatoIpLimiter/);
  assert.match(cadastroRoutes, /cadastroFisioEmailLimiter/);
  assert.match(cadastroRoutes, /cadastroFisioTelefoneLimiter/);
  assert.match(limiter, /normalizarTelefoneRateLimit/);
  assert.match(cadastroService, /FISIO_CADASTRO_TELEFONE_DAILY_MAX/);
  assert.match(cadastroService, /sp_getapplock/);
});

test('fila ignora OTP de pré-cadastro substituído, confirmado ou expirado', () => {
  assert.match(filaService, /VerificacaoCadastroFisioterapeuta/);
  assert.match(filaService, /verificacaoCadastroFisioterapeutaAindaPendente/);
  assert.match(filaService, /codigo_substituido_ou_expirado/);
});

test('limpeza pertence ao pacote de jobs e chama somente a procedure V135', () => {
  assert.match(cleanupJob, /runSqlJob/);
  assert.match(cleanupJob, /\.execute\('dbo\.SP_LimparCadastrosFisioPendentes'\)/);
  assert.match(jobsPackage, /src\/functions\/limparCadastrosFisioPendentes\.js/);
});
