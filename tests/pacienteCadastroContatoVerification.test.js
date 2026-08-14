import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function source(relative) {
  return fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
}

const migration = source('sql/PACIENTE_CADASTRO_CONTATO_VERIFICACAO_V136.sql');
const cadastroService = source('services/pacienteCadastroContatoService.js');
const pacientesService = source('services/pacientesService.js');
const filaService = source('services/contatoFilaService.js');
const cadastroRoutes = source('routes/cadastro.js');
const limiter = source('middleware/apiLimiter.js');
const env = source('config/env.js');
const jobsPackage = source('azure-functions/package.json');
const cleanupJob = source('azure-functions/src/functions/limparCadastrosPacientePendentes.js');
const pacientesRoutes = source('routes/pacientes.js');
const pacientesController = source('controllers/pacientesController.js');
const contatoTemplates = source('services/contatoTemplates.js');

test('V136 cria sessão, verificações por canal e procedure de limpeza idempotente', () => {
  assert.match(migration, /PacienteCadastroSessoes/);
  assert.match(migration, /PacienteCadastroVerificacoes/);
  assert.match(migration, /UNIQUE \(CadastroSessaoId, Canal\)/);
  assert.match(migration, /Canal IN \(N'Email', N'Telefone'\)/);
  assert.match(migration, /CREATE OR ALTER PROCEDURE dbo\.SP_LimparCadastrosPacientePendentes/);
});

test('códigos usam hash HMAC, salt aleatório, comparação segura e não são persistidos na sessão', () => {
  assert.match(cadastroService, /crypto\.randomBytes\(16\)/);
  assert.match(cadastroService, /createHmac\('sha256', getContatoSecret\(\)\)/);
  assert.match(cadastroService, /crypto\.timingSafeEqual/);
  assert.doesNotMatch(migration, /Codigo\s+NVARCHAR/);
});

test('prova fica vinculada à sessão, CPF, e-mail e telefone', () => {
  assert.match(cadastroService, /paciente-cadastro-contato:v1:/);
  assert.match(cadastroService, /email: emailNorm/);
  assert.match(cadastroService, /telefone: telefoneNorm/);
  assert.match(cadastroService, /cpf: cpfNorm/);
});

test('criação consome a sessão na mesma transação e grava os dois contatos verificados', () => {
  const begin = pacientesService.indexOf('BEGIN TRAN;', pacientesService.indexOf('async criar'));
  const commit = pacientesService.indexOf('COMMIT;', begin);
  const block = pacientesService.slice(begin, commit);
  assert.match(block, /WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(block, /EmailVerificado, EmailVerificadoEm/);
  assert.match(block, /TelefoneVerificado, TelefoneVerificadoEm/);
  assert.match(block, /Status = N'Consumido'/);
  assert.match(block, /PacienteId = @NewId/);
});

test('cadastro público captura e devolve um Id positivo de forma explícita', () => {
  assert.match(pacientesService, /OUTPUT INSERTED\.Id INTO @NovoId\(Id\)/);
  assert.match(pacientesService, /Não foi possível identificar o paciente criado/);
  assert.match(pacientesService, /return novo;/);
});

test('env valida modos de rollout e o fluxo novo não envia e-mail pós-criação', () => {
  assert.match(env, /PACIENTE_CADASTRO_CONTATO_PREVALIDACAO_MODE/);
  assert.match(env, /\['optional', 'required'\]/);
  assert.match(env, /PACIENTE_LOGIN_CONTATO_GATE_MODE/);
  assert.match(pacientesService, /if \(!contatosPrevalidados\)/);
});

test('OAuth pode confirmar somente o e-mail e o telefone continua no fluxo de código', () => {
  assert.match(cadastroService, /oauthConfirmaEmail/);
  assert.match(cadastroService, /OrigemConfirmacao=N'OAuth'/);
  assert.match(cadastroService, /CADASTRO_EMAIL_NOT_CONFIRMED/);
});

test('gate autenticado do paciente usa endpoint me e flags próprias', () => {
  assert.match(pacientesRoutes, /\/me\/status-verificacao/);
  assert.match(pacientesController, /statusVerificacaoMe/);
  assert.match(pacientesService, /PACIENTE_LOGIN_CONTATO_GATE_MODE/);
  assert.match(pacientesService, /pendenciasObrigatorias/);
});

test('templates de pré-cadastro não instruem acessar uma conta ainda inexistente', () => {
  const inicio = contatoTemplates.indexOf('montarEmailVerificacaoCadastroPaciente');
  const fim = contatoTemplates.indexOf('montarEmailVerificacaoCadastroFisioterapeuta', inicio);
  const bloco = contatoTemplates.slice(inicio, fim);
  assert.ok(inicio >= 0 && fim > inicio);
  assert.match(bloco, /etapa de validação do cadastro de paciente/);
  assert.doesNotMatch(bloco, /Minha Conta/);
});

test('endpoints públicos têm limites por IP, e-mail normalizado e telefone normalizado', () => {
  assert.match(cadastroRoutes, /cadastroPacienteContatoIpLimiter/);
  assert.match(cadastroRoutes, /cadastroPacienteEmailLimiter/);
  assert.match(cadastroRoutes, /cadastroPacienteTelefoneLimiter/);
  assert.match(limiter, /normalizarTelefoneRateLimit/);
  assert.match(cadastroService, /PACIENTE_CADASTRO_TELEFONE_DAILY_MAX/);
  assert.match(cadastroService, /sp_getapplock/);
});

test('fila ignora OTP de pré-cadastro substituído, confirmado ou expirado', () => {
  assert.match(filaService, /VerificacaoCadastroPaciente/);
  assert.match(filaService, /verificacaoCadastroPacienteAindaPendente/);
  assert.match(filaService, /codigo_substituido_ou_expirado/);
});

test('limpeza pertence ao pacote de jobs e chama somente a procedure V136', () => {
  assert.match(cleanupJob, /runSqlJob/);
  assert.match(cleanupJob, /\.execute\('dbo\.SP_LimparCadastrosPacientePendentes'\)/);
  assert.match(jobsPackage, /src\/functions\/limparCadastrosPacientePendentes\.js/);
});
