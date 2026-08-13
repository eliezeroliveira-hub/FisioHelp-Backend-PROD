import crypto from 'crypto';
import { sql } from '../config/dbConfig.js';
import { ENV } from '../config/env.js';
import contatoProvider from '../providers/contatoProvider.js';
import { HttpError } from '../utils/httpError.js';
import { getContatoSecret } from '../utils/contactSecret.js';
import { isValidEmail, normalizeEmail } from '../utils/identityValidators.js';
import { queryWithContext } from './_queryWithContext.js';
import { authService } from './authService.js';
import {
  montarEmailVerificacaoCadastroFisioterapeuta,
  montarTextoTelefoneVerificacaoCadastroFisioterapeuta,
} from './contatoTemplates.js';

const CODIGO_EXPIRA_MINUTOS = 10;
const SESSAO_EXPIRA_HORAS = 24;
const COOLDOWN_SEGUNDOS = 60;
const MAX_TENTATIVAS = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function normalizarTelefoneCadastro(value) {
  const digits = onlyDigits(value);
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return digits.slice(2);
  }
  return digits;
}

export function normalizarTelefoneE164Cadastro(value) {
  const local = normalizarTelefoneCadastro(value);
  return local.length === 10 || local.length === 11 ? `+55${local}` : '';
}

export function normalizarCrefitoCadastro(value) {
  const digits = onlyDigits(value);
  if (digits.length < 4 || digits.length > 6) {
    throw new HttpError(400, 'CREFITO deve conter entre 4 e 6 números.');
  }
  return `${digits}-F`;
}

function validarIdSessao(value, { obrigatorio = true } = {}) {
  const id = String(value || '').trim();
  if (!id && !obrigatorio) return null;
  if (!UUID_RE.test(id)) throw new HttpError(400, 'Sessão de validação inválida.');
  return id.toLowerCase();
}

function gerarCodigo6() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function gerarSalt16() {
  return crypto.randomBytes(16);
}

function calcularCodigoHash({ salt, canal, codigo, destino }) {
  const saltHex = Buffer.isBuffer(salt) ? salt.toString('hex') : String(salt || '');
  return crypto
    .createHmac('sha256', getContatoSecret())
    .update(`${saltHex}:${canal}:${codigo}:${destino}`, 'utf8')
    .digest();
}

function assinaturaProva({ sessaoId, exp, email, telefone, crefito }) {
  return crypto
    .createHmac('sha256', getContatoSecret())
    .update(`fisio-cadastro-contato:v1:${sessaoId}:${exp}:${email}:${telefone}:${crefito}`, 'utf8')
    .digest('base64url');
}

function emitirProva(row) {
  const sessaoId = String(row?.Id || row?.CadastroSessaoId || '').toLowerCase();
  const expiraEm = row?.ExpiraEm ? new Date(row.ExpiraEm) : null;
  if (!UUID_RE.test(sessaoId) || !expiraEm || Number.isNaN(expiraEm.getTime())) return null;

  const exp = Math.floor(expiraEm.getTime() / 1000);
  const assinatura = assinaturaProva({
    sessaoId,
    exp,
    email: String(row.EmailNormalizado || ''),
    telefone: String(row.TelefoneNormalizado || ''),
    crefito: String(row.CrefitoNormalizado || ''),
  });
  return `v1.${sessaoId}.${exp}.${assinatura}`;
}

export function validarProvaContatoCadastro(prova, { email, telefone, crefito } = {}) {
  const token = String(prova || '').trim();
  const [versao, sessaoIdRaw, expRaw, assinaturaRaw, extra] = token.split('.');
  const sessaoId = String(sessaoIdRaw || '').toLowerCase();
  const exp = Number(expRaw);

  if (versao !== 'v1' || extra !== undefined || !UUID_RE.test(sessaoId) || !Number.isInteger(exp)) {
    throw new HttpError(422, 'Confirmação de e-mail e telefone inválida.');
  }
  if (exp <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(422, 'Confirmação de e-mail e telefone expirada.');
  }

  const emailNorm = normalizeEmail(email);
  const telefoneNorm = normalizarTelefoneCadastro(telefone);
  const crefitoNorm = normalizarCrefitoCadastro(crefito);
  const esperado = assinaturaProva({ sessaoId, exp, email: emailNorm, telefone: telefoneNorm, crefito: crefitoNorm });
  const recebido = String(assinaturaRaw || '');
  const esperadoBuf = Buffer.from(esperado, 'utf8');
  const recebidoBuf = Buffer.from(recebido, 'utf8');

  if (esperadoBuf.length !== recebidoBuf.length || !crypto.timingSafeEqual(esperadoBuf, recebidoBuf)) {
    throw new HttpError(422, 'Confirmação de e-mail e telefone não corresponde aos dados informados.');
  }

  return { sessaoId, expiraEm: new Date(exp * 1000) };
}

function mascarar(canal, destino) {
  return contatoProvider?.mascararDestino
    ? contatoProvider.mascararDestino(canal, destino)
    : destino;
}

function mapDbError(error) {
  if (error instanceof HttpError) return error;
  const message = String(error?.message || error?.originalError?.info?.message || '');
  const mappings = [
    ['CADASTRO_SESSION_NOT_FOUND', 404, 'Sessão de validação não encontrada.'],
    ['CADASTRO_SESSION_EXPIRED', 410, 'Sessão de validação expirada. Inicie novamente.'],
    ['CADASTRO_SESSION_MISMATCH', 409, 'Os dados informados não correspondem à sessão de validação.'],
    ['CADASTRO_SESSION_CONSUMED', 409, 'Esta sessão de validação já foi utilizada.'],
    ['CADASTRO_EMAIL_NOT_CONFIRMED', 409, 'Confirme o e-mail antes de validar o telefone.'],
    ['CADASTRO_CODE_NOT_FOUND', 404, 'Nenhum código pendente foi encontrado.'],
    ['CADASTRO_CODE_EXPIRED', 410, 'Código expirado. Solicite um novo.'],
    ['CADASTRO_CODE_BLOCKED', 429, 'Código bloqueado por excesso de tentativas. Solicite um novo.'],
    ['CADASTRO_CODE_ALREADY_PROCESSED', 409, 'Código já processado. Solicite um novo.'],
    ['CADASTRO_CONTACT_DAILY_LIMIT', 429, 'Limite diário de envios atingido para este contato. Tente novamente mais tarde.'],
    ['CADASTRO_CONTACT_COOLDOWN', 429, 'Aguarde antes de solicitar um novo código.'],
    ['CADASTRO_CONTACT_TABLE_MISSING', 503, 'Validação de cadastro temporariamente indisponível.'],
  ];
  for (const [marker, status, publicMessage] of mappings) {
    if (message.includes(marker)) return new HttpError(status, publicMessage);
  }
  return error;
}

async function garantirDisponibilidade({ email, telefone, crefito }) {
  const result = await queryWithContext(null, (req) => {
    req.input('Email', sql.NVarChar(300), email);
    req.input('Telefone', sql.NVarChar(60), telefone);
    req.input('CREFITO', sql.NVarChar(20), crefito);
  }, `
    SELECT
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.UsuariosEmailsUnicos WHERE EmailNormalizado = @Email
      ) THEN 1 ELSE 0 END AS EmailEmUso,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.UsuariosTelefonesUnicos WHERE TelefoneNormalizado = @Telefone
      ) THEN 1 ELSE 0 END AS TelefoneEmUso,
      CASE WHEN EXISTS (
        SELECT 1 FROM dbo.Fisioterapeutas WHERE CREFITO = @CREFITO
      ) THEN 1 ELSE 0 END AS CrefitoEmUso;
  `);

  const row = result.recordset?.[0] || {};
  if (Number(row.EmailEmUso) === 1) throw new HttpError(409, 'E-mail já cadastrado.');
  if (Number(row.TelefoneEmUso) === 1) throw new HttpError(409, 'Telefone já cadastrado.');
  if (Number(row.CrefitoEmUso) === 1) throw new HttpError(409, 'CREFITO já cadastrado.');
}

async function oauthConfirmaEmail(token, email) {
  const oauth = authService.validarOAuthCadastroToken(token);
  if (!oauth) return false;

  const result = await queryWithContext(null, (req) => {
    req.input('Jti', sql.UniqueIdentifier, oauth.jti);
    req.input('Provedor', sql.NVarChar(30), oauth.provider);
    req.input('Subject', sql.NVarChar(255), oauth.subject);
  }, `
    SELECT TOP (1) Email, EmailVerificado, ExpiraEm, UsadoEm
    FROM dbo.OAuthCadastroTokens
    WHERE Jti = @Jti AND Provedor = @Provedor AND Subject = @Subject;
  `);
  const row = result.recordset?.[0];
  return Boolean(
    row &&
    row.UsadoEm == null &&
    row.ExpiraEm && new Date(row.ExpiraEm).getTime() > Date.now() &&
    Number(row.EmailVerificado) === 1 &&
    normalizeEmail(row.Email) === email
  );
}

function normalizarDadosIniciais(dados = {}) {
  const nome = String(dados.Nome ?? dados.nome ?? '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(dados.Email ?? dados.email);
  const telefone = normalizarTelefoneCadastro(dados.Telefone ?? dados.telefone);
  const crefito = normalizarCrefitoCadastro(dados.CREFITO ?? dados.crefito);

  if (!nome || nome.length < 2 || nome.length > 150) throw new HttpError(400, 'Nome inválido.');
  if (!isValidEmail(email)) throw new HttpError(400, 'E-mail inválido.');
  if (telefone.length < 10 || telefone.length > 11) {
    throw new HttpError(400, 'Telefone inválido: use DDD + número.');
  }
  return { nome, email, telefone, crefito };
}

function formatarResposta(row) {
  const emailConfirmado = Number(row?.EmailConfirmado ?? 0) === 1;
  const telefoneConfirmado = Number(row?.TelefoneConfirmado ?? 0) === 1;
  const ambos = emailConfirmado && telefoneConfirmado;
  return {
    cadastroValidacaoId: String(row?.Id || row?.CadastroSessaoId || ''),
    status: String(row?.Status || 'EmAndamento'),
    email: {
      verificado: emailConfirmado,
      destinoMascarado: mascarar('Email', row?.EmailNormalizado),
    },
    telefone: {
      verificado: telefoneConfirmado,
      destinoMascarado: mascarar('Telefone', row?.TelefoneNormalizado),
    },
    proximoCanal: !emailConfirmado ? 'Email' : (!telefoneConfirmado ? 'Telefone' : null),
    contatosVerificados: ambos,
    expiraEm: row?.ExpiraEm || null,
    podeReenviarEm: row?.PodeReenviarEm || null,
    codigoJaEnviado: Number(row?.CodigoJaEnviado ?? 0) === 1,
    envioPendente: Number(row?.EnvioPendente ?? 0) === 1,
    contatoVerificationProof: ambos ? emitirProva(row) : null,
  };
}

async function solicitarEmail(dados = {}) {
  const inicial = normalizarDadosIniciais(dados);
  const sessaoInformada = validarIdSessao(
    dados.CadastroValidacaoId ?? dados.cadastroValidacaoId,
    { obrigatorio: false }
  );
  const sessaoId = sessaoInformada || crypto.randomUUID();
  const forcar = dados.ForcarReenvio ?? dados.forcarReenvio ?? false;
  await garantirDisponibilidade(inicial);

  const oauthToken = dados.OAuthCadastroToken ?? dados.oauthCadastroToken ?? null;
  const confirmadoViaOAuth = await oauthConfirmaEmail(oauthToken, inicial.email);
  const codigo = confirmadoViaOAuth ? null : gerarCodigo6();
  const salt = confirmadoViaOAuth ? null : gerarSalt16();
  const codigoHash = confirmadoViaOAuth ? null : calcularCodigoHash({
    salt,
    canal: 'Email',
    codigo,
    destino: inicial.email,
  });
  const conteudo = confirmadoViaOAuth
    ? null
    : montarEmailVerificacaoCadastroFisioterapeuta({
        nome: inicial.nome,
        codigo,
        expiraEmMinutos: CODIGO_EXPIRA_MINUTOS,
      });
  const payload = confirmadoViaOAuth ? null : JSON.stringify({
    cadastroSessaoId: sessaoId,
    canal: 'Email',
    destino: inicial.email,
    codigo,
    codigoHashHex: codigoHash.toString('hex'),
    origem: 'cadastro.fisioterapeuta',
  });

  try {
    const result = await queryWithContext(null, (req) => {
      req.input('Id', sql.UniqueIdentifier, sessaoId);
      req.input('SessaoInformada', sql.Bit, sessaoInformada ? 1 : 0);
      req.input('Nome', sql.NVarChar(150), inicial.nome);
      req.input('CREFITO', sql.NVarChar(20), inicial.crefito);
      req.input('Email', sql.NVarChar(300), inicial.email);
      req.input('Telefone', sql.NVarChar(20), inicial.telefone);
      req.input('ConfirmarOAuth', sql.Bit, confirmadoViaOAuth ? 1 : 0);
      req.input('ForcarReenvio', sql.Bit, forcar ? 1 : 0);
      req.input('CodigoHash', sql.VarBinary(32), codigoHash);
      req.input('CodigoSalt', sql.VarBinary(16), salt);
      req.input('MaxTentativas', sql.SmallInt, MAX_TENTATIVAS);
      req.input('CodigoExpiraMinutos', sql.Int, CODIGO_EXPIRA_MINUTOS);
      req.input('SessaoExpiraHoras', sql.Int, SESSAO_EXPIRA_HORAS);
      req.input('CooldownSegundos', sql.Int, COOLDOWN_SEGUNDOS);
      req.input('LimiteDiario', sql.Int, Number(ENV.FISIO_CADASTRO_EMAIL_DAILY_MAX || 10));
      req.input('Assunto', sql.NVarChar(200), conteudo?.assunto || null);
      req.input('Html', sql.NVarChar(sql.MAX), conteudo?.corpoHtml || null);
      req.input('Texto', sql.NVarChar(sql.MAX), conteudo?.corpoTexto || null);
      req.input('PayloadJson', sql.NVarChar(sql.MAX), payload);
      req.input('UsuarioRegistro', sql.NVarChar(200), `CadastroFisioterapeuta:${sessaoId}`);
    }, `
      SET XACT_ABORT ON;
      IF OBJECT_ID(N'dbo.FisioterapeutaCadastroSessoes', N'U') IS NULL
        THROW 50400, N'CADASTRO_CONTACT_TABLE_MISSING', 1;

      BEGIN TRAN;
      DECLARE @LockResult INT;
      DECLARE @LockResource NVARCHAR(255) = N'CadastroFisioOtp:' +
        CONVERT(NVARCHAR(64), HASHBYTES('SHA2_256', N'Email:' + @Email), 2);
      EXEC @LockResult = sys.sp_getapplock @Resource=@LockResource, @LockMode='Exclusive',
        @LockOwner='Transaction', @LockTimeout=5000;
      IF @LockResult < 0 THROW 50411, N'CADASTRO_CONTACT_COOLDOWN', 1;

      IF @SessaoInformada = 0
      BEGIN
        INSERT INTO dbo.FisioterapeutaCadastroSessoes
          (Id, NomeInformado, CrefitoNormalizado, EmailNormalizado, TelefoneNormalizado, Status, ExpiraEm)
        VALUES
          (@Id, @Nome, @CREFITO, @Email, @Telefone, N'EmAndamento', DATEADD(HOUR, @SessaoExpiraHoras, SYSDATETIME()));
      END

      DECLARE @StatusSessao NVARCHAR(30), @ExpiraSessao DATETIME2(7);
      SELECT @StatusSessao=Status, @ExpiraSessao=ExpiraEm
      FROM dbo.FisioterapeutaCadastroSessoes WITH (UPDLOCK, HOLDLOCK)
      WHERE Id=@Id;

      IF @StatusSessao IS NULL THROW 50401, N'CADASTRO_SESSION_NOT_FOUND', 1;
      IF @StatusSessao = N'Consumido' THROW 50402, N'CADASTRO_SESSION_CONSUMED', 1;
      IF @StatusSessao IN (N'Expirado', N'Cancelado') OR @ExpiraSessao <= SYSDATETIME()
        THROW 50403, N'CADASTRO_SESSION_EXPIRED', 1;
      IF NOT EXISTS (
        SELECT 1 FROM dbo.FisioterapeutaCadastroSessoes
        WHERE Id=@Id AND CrefitoNormalizado=@CREFITO AND EmailNormalizado=@Email
          AND TelefoneNormalizado=@Telefone
      ) THROW 50404, N'CADASTRO_SESSION_MISMATCH', 1;

      IF @ConfirmarOAuth = 1
      BEGIN
        MERGE dbo.FisioterapeutaCadastroVerificacoes AS t
        USING (SELECT @Id CadastroSessaoId, N'Email' Canal) AS s
          ON t.CadastroSessaoId=s.CadastroSessaoId AND t.Canal=s.Canal
        WHEN MATCHED THEN UPDATE SET DestinoNormalizado=@Email, CodigoHash=NULL, CodigoSalt=NULL,
          Tentativas=0, Status=N'Confirmado', ExpiraEm=NULL, UltimoEnvioEm=NULL,
          ConfirmadoEm=SYSDATETIME(), OrigemConfirmacao=N'OAuth', AtualizadoEm=SYSDATETIME()
        WHEN NOT MATCHED THEN INSERT
          (CadastroSessaoId, Canal, DestinoNormalizado, Tentativas, MaxTentativas, Status, ConfirmadoEm, OrigemConfirmacao)
          VALUES (@Id, N'Email', @Email, 0, @MaxTentativas, N'Confirmado', SYSDATETIME(), N'OAuth');
      END
      ELSE
      BEGIN
        DECLARE @StatusCodigo NVARCHAR(20), @ExpiraCodigo DATETIME2(7), @UltimoEnvio DATETIME2(7);
        SELECT @StatusCodigo=Status, @ExpiraCodigo=ExpiraEm, @UltimoEnvio=UltimoEnvioEm
        FROM dbo.FisioterapeutaCadastroVerificacoes WITH (UPDLOCK, HOLDLOCK)
        WHERE CadastroSessaoId=@Id AND Canal=N'Email';

        IF @StatusCodigo = N'Confirmado'
        BEGIN
          COMMIT;
          SELECT s.*, CAST(1 AS BIT) EmailConfirmado,
            CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
              WHERE CadastroSessaoId=s.Id AND Canal=N'Telefone' AND Status=N'Confirmado') THEN 1 ELSE 0 END AS BIT) TelefoneConfirmado,
            CAST(0 AS BIT) CodigoJaEnviado, CAST(0 AS BIT) EnvioPendente, CAST(NULL AS DATETIME2) PodeReenviarEm
          FROM dbo.FisioterapeutaCadastroSessoes s WHERE s.Id=@Id;
          RETURN;
        END

        IF @StatusCodigo=N'Pendente' AND @ExpiraCodigo>SYSDATETIME() AND @ForcarReenvio=0
        BEGIN
          COMMIT;
          SELECT s.*, CAST(0 AS BIT) EmailConfirmado,
            CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
              WHERE CadastroSessaoId=s.Id AND Canal=N'Telefone' AND Status=N'Confirmado') THEN 1 ELSE 0 END AS BIT) TelefoneConfirmado,
            CAST(1 AS BIT) CodigoJaEnviado, CAST(0 AS BIT) EnvioPendente,
            DATEADD(SECOND,@CooldownSegundos,@UltimoEnvio) PodeReenviarEm
          FROM dbo.FisioterapeutaCadastroSessoes s WHERE s.Id=@Id;
          RETURN;
        END

        IF @UltimoEnvio IS NOT NULL AND DATEDIFF(SECOND,@UltimoEnvio,SYSDATETIME())<@CooldownSegundos
          THROW 50411, N'CADASTRO_CONTACT_COOLDOWN', 1;
        IF (SELECT COUNT_BIG(1) FROM dbo.FilaContatoTransacional WITH (UPDLOCK,HOLDLOCK)
            WHERE Tipo=N'VerificacaoCadastroFisioterapeuta' AND Canal=N'Email'
              AND Destino=@Email AND CriadoEm>=DATEADD(HOUR,-24,SYSDATETIME())) >= @LimiteDiario
          THROW 50410, N'CADASTRO_CONTACT_DAILY_LIMIT', 1;

        MERGE dbo.FisioterapeutaCadastroVerificacoes AS t
        USING (SELECT @Id CadastroSessaoId, N'Email' Canal) AS s
          ON t.CadastroSessaoId=s.CadastroSessaoId AND t.Canal=s.Canal
        WHEN MATCHED THEN UPDATE SET DestinoNormalizado=@Email, CodigoHash=@CodigoHash,
          CodigoSalt=@CodigoSalt, Tentativas=0, MaxTentativas=@MaxTentativas, Status=N'Pendente',
          ExpiraEm=DATEADD(MINUTE,@CodigoExpiraMinutos,SYSDATETIME()), UltimoEnvioEm=SYSDATETIME(),
          ConfirmadoEm=NULL, OrigemConfirmacao=NULL, AtualizadoEm=SYSDATETIME()
        WHEN NOT MATCHED THEN INSERT
          (CadastroSessaoId,Canal,DestinoNormalizado,CodigoHash,CodigoSalt,Tentativas,MaxTentativas,
           Status,ExpiraEm,UltimoEnvioEm)
          VALUES (@Id,N'Email',@Email,@CodigoHash,@CodigoSalt,0,@MaxTentativas,N'Pendente',
            DATEADD(MINUTE,@CodigoExpiraMinutos,SYSDATETIME()),SYSDATETIME());

        INSERT INTO dbo.FilaContatoTransacional
          (Tipo,Canal,Destino,Assunto,Html,Texto,PayloadJson,Status,Tentativas,MaxTentativas,
           ProximaTentativaEm,UsuarioRegistro)
        VALUES (N'VerificacaoCadastroFisioterapeuta',N'Email',@Email,@Assunto,@Html,@Texto,@PayloadJson,
          N'Pendente',0,5,SYSDATETIME(),@UsuarioRegistro);
      END

      UPDATE s SET Status=CASE WHEN EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
          WHERE CadastroSessaoId=@Id AND Canal=N'Email' AND Status=N'Confirmado')
        AND EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
          WHERE CadastroSessaoId=@Id AND Canal=N'Telefone' AND Status=N'Confirmado')
        THEN N'ContatosConfirmados' ELSE N'EmAndamento' END,
        ContatosConfirmadosEm=CASE WHEN EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
          WHERE CadastroSessaoId=@Id AND Canal=N'Email' AND Status=N'Confirmado')
        AND EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
          WHERE CadastroSessaoId=@Id AND Canal=N'Telefone' AND Status=N'Confirmado')
        THEN COALESCE(ContatosConfirmadosEm,SYSDATETIME()) ELSE NULL END,
        AtualizadoEm=SYSDATETIME()
      FROM dbo.FisioterapeutaCadastroSessoes s WHERE s.Id=@Id;

      COMMIT;
      SELECT s.*,
        CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
          WHERE CadastroSessaoId=s.Id AND Canal=N'Email' AND Status=N'Confirmado') THEN 1 ELSE 0 END AS BIT) EmailConfirmado,
        CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
          WHERE CadastroSessaoId=s.Id AND Canal=N'Telefone' AND Status=N'Confirmado') THEN 1 ELSE 0 END AS BIT) TelefoneConfirmado,
        CAST(0 AS BIT) CodigoJaEnviado, CAST(CASE WHEN @ConfirmarOAuth=0 THEN 1 ELSE 0 END AS BIT) EnvioPendente,
        CASE WHEN @ConfirmarOAuth=0 THEN DATEADD(SECOND,@CooldownSegundos,SYSDATETIME()) ELSE NULL END PodeReenviarEm
      FROM dbo.FisioterapeutaCadastroSessoes s WHERE s.Id=@Id;
    `);
    return formatarResposta(result.recordset?.[0]);
  } catch (error) {
    throw mapDbError(error);
  }
}

async function solicitarTelefone(dados = {}) {
  const sessaoId = validarIdSessao(dados.CadastroValidacaoId ?? dados.cadastroValidacaoId);
  const telefone = normalizarTelefoneCadastro(dados.Telefone ?? dados.telefone);
  const destino = normalizarTelefoneE164Cadastro(telefone);
  if (!destino) throw new HttpError(400, 'Telefone inválido: use DDD + número.');
  const forcar = dados.ForcarReenvio ?? dados.forcarReenvio ?? false;
  const codigo = gerarCodigo6();
  const salt = gerarSalt16();
  const codigoHash = calcularCodigoHash({ salt, canal: 'Telefone', codigo, destino });
  const texto = montarTextoTelefoneVerificacaoCadastroFisioterapeuta({
    codigo,
    expiraEmMinutos: CODIGO_EXPIRA_MINUTOS,
  });
  const payload = JSON.stringify({
    cadastroSessaoId: sessaoId,
    canal: 'Telefone',
    destino,
    codigo,
    codigoHashHex: codigoHash.toString('hex'),
    origem: 'cadastro.fisioterapeuta',
  });

  try {
    const result = await queryWithContext(null, (req) => {
      req.input('Id', sql.UniqueIdentifier, sessaoId);
      req.input('Telefone', sql.NVarChar(20), telefone);
      req.input('Destino', sql.NVarChar(40), destino);
      req.input('ForcarReenvio', sql.Bit, forcar ? 1 : 0);
      req.input('CodigoHash', sql.VarBinary(32), codigoHash);
      req.input('CodigoSalt', sql.VarBinary(16), salt);
      req.input('MaxTentativas', sql.SmallInt, MAX_TENTATIVAS);
      req.input('CodigoExpiraMinutos', sql.Int, CODIGO_EXPIRA_MINUTOS);
      req.input('CooldownSegundos', sql.Int, COOLDOWN_SEGUNDOS);
      req.input('LimiteDiario', sql.Int, Number(ENV.FISIO_CADASTRO_TELEFONE_DAILY_MAX || 6));
      req.input('Texto', sql.NVarChar(sql.MAX), texto);
      req.input('PayloadJson', sql.NVarChar(sql.MAX), payload);
      req.input('UsuarioRegistro', sql.NVarChar(200), `CadastroFisioterapeuta:${sessaoId}`);
    }, `
      SET XACT_ABORT ON;
      BEGIN TRAN;
      DECLARE @LockResult INT;
      DECLARE @LockResource NVARCHAR(255)=N'CadastroFisioOtp:'+
        CONVERT(NVARCHAR(64),HASHBYTES('SHA2_256',N'Telefone:'+@Destino),2);
      EXEC @LockResult=sys.sp_getapplock @Resource=@LockResource,@LockMode='Exclusive',
        @LockOwner='Transaction',@LockTimeout=5000;
      IF @LockResult<0 THROW 50411,N'CADASTRO_CONTACT_COOLDOWN',1;

      DECLARE @StatusSessao NVARCHAR(30),@ExpiraSessao DATETIME2(7),@TelefoneSessao NVARCHAR(20);
      SELECT @StatusSessao=Status,@ExpiraSessao=ExpiraEm,@TelefoneSessao=TelefoneNormalizado
      FROM dbo.FisioterapeutaCadastroSessoes WITH (UPDLOCK,HOLDLOCK) WHERE Id=@Id;
      IF @StatusSessao IS NULL THROW 50401,N'CADASTRO_SESSION_NOT_FOUND',1;
      IF @StatusSessao=N'Consumido' THROW 50402,N'CADASTRO_SESSION_CONSUMED',1;
      IF @StatusSessao IN (N'Expirado',N'Cancelado') OR @ExpiraSessao<=SYSDATETIME()
        THROW 50403,N'CADASTRO_SESSION_EXPIRED',1;
      IF @TelefoneSessao<>@Telefone THROW 50404,N'CADASTRO_SESSION_MISMATCH',1;
      IF NOT EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
        WHERE CadastroSessaoId=@Id AND Canal=N'Email' AND Status=N'Confirmado')
        THROW 50405,N'CADASTRO_EMAIL_NOT_CONFIRMED',1;
      IF EXISTS (SELECT 1 FROM dbo.UsuariosTelefonesUnicos WHERE TelefoneNormalizado=@Telefone)
        THROW 50404,N'CADASTRO_SESSION_MISMATCH',1;

      DECLARE @StatusCodigo NVARCHAR(20),@ExpiraCodigo DATETIME2(7),@UltimoEnvio DATETIME2(7);
      SELECT @StatusCodigo=Status,@ExpiraCodigo=ExpiraEm,@UltimoEnvio=UltimoEnvioEm
      FROM dbo.FisioterapeutaCadastroVerificacoes WITH (UPDLOCK,HOLDLOCK)
      WHERE CadastroSessaoId=@Id AND Canal=N'Telefone';
      IF @StatusCodigo=N'Confirmado'
      BEGIN
        COMMIT;
        SELECT s.*,CAST(1 AS BIT) EmailConfirmado,CAST(1 AS BIT) TelefoneConfirmado,
          CAST(0 AS BIT) CodigoJaEnviado,CAST(0 AS BIT) EnvioPendente,CAST(NULL AS DATETIME2) PodeReenviarEm
        FROM dbo.FisioterapeutaCadastroSessoes s WHERE s.Id=@Id;
        RETURN;
      END
      IF @StatusCodigo=N'Pendente' AND @ExpiraCodigo>SYSDATETIME() AND @ForcarReenvio=0
      BEGIN
        COMMIT;
        SELECT s.*,CAST(1 AS BIT) EmailConfirmado,CAST(0 AS BIT) TelefoneConfirmado,
          CAST(1 AS BIT) CodigoJaEnviado,CAST(0 AS BIT) EnvioPendente,
          DATEADD(SECOND,@CooldownSegundos,@UltimoEnvio) PodeReenviarEm
        FROM dbo.FisioterapeutaCadastroSessoes s WHERE s.Id=@Id;
        RETURN;
      END
      IF @UltimoEnvio IS NOT NULL AND DATEDIFF(SECOND,@UltimoEnvio,SYSDATETIME())<@CooldownSegundos
        THROW 50411,N'CADASTRO_CONTACT_COOLDOWN',1;
      IF (SELECT COUNT_BIG(1) FROM dbo.FilaContatoTransacional WITH (UPDLOCK,HOLDLOCK)
          WHERE Tipo=N'VerificacaoCadastroFisioterapeuta' AND Canal=N'Telefone'
            AND Destino=@Destino AND CriadoEm>=DATEADD(HOUR,-24,SYSDATETIME()))>=@LimiteDiario
        THROW 50410,N'CADASTRO_CONTACT_DAILY_LIMIT',1;

      MERGE dbo.FisioterapeutaCadastroVerificacoes AS t
      USING (SELECT @Id CadastroSessaoId,N'Telefone' Canal) AS s
        ON t.CadastroSessaoId=s.CadastroSessaoId AND t.Canal=s.Canal
      WHEN MATCHED THEN UPDATE SET DestinoNormalizado=@Destino,CodigoHash=@CodigoHash,
        CodigoSalt=@CodigoSalt,Tentativas=0,MaxTentativas=@MaxTentativas,Status=N'Pendente',
        ExpiraEm=DATEADD(MINUTE,@CodigoExpiraMinutos,SYSDATETIME()),UltimoEnvioEm=SYSDATETIME(),
        ConfirmadoEm=NULL,OrigemConfirmacao=NULL,AtualizadoEm=SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (CadastroSessaoId,Canal,DestinoNormalizado,CodigoHash,CodigoSalt,Tentativas,MaxTentativas,
         Status,ExpiraEm,UltimoEnvioEm)
        VALUES (@Id,N'Telefone',@Destino,@CodigoHash,@CodigoSalt,0,@MaxTentativas,N'Pendente',
          DATEADD(MINUTE,@CodigoExpiraMinutos,SYSDATETIME()),SYSDATETIME());

      INSERT INTO dbo.FilaContatoTransacional
        (Tipo,Canal,Destino,Assunto,Html,Texto,PayloadJson,Status,Tentativas,MaxTentativas,
         ProximaTentativaEm,UsuarioRegistro)
      VALUES (N'VerificacaoCadastroFisioterapeuta',N'Telefone',@Destino,NULL,NULL,@Texto,@PayloadJson,
        N'Pendente',0,5,SYSDATETIME(),@UsuarioRegistro);
      UPDATE dbo.FisioterapeutaCadastroSessoes SET AtualizadoEm=SYSDATETIME() WHERE Id=@Id;
      COMMIT;
      SELECT s.*,CAST(1 AS BIT) EmailConfirmado,CAST(0 AS BIT) TelefoneConfirmado,
        CAST(0 AS BIT) CodigoJaEnviado,CAST(1 AS BIT) EnvioPendente,
        DATEADD(SECOND,@CooldownSegundos,SYSDATETIME()) PodeReenviarEm
      FROM dbo.FisioterapeutaCadastroSessoes s WHERE s.Id=@Id;
    `);
    return formatarResposta(result.recordset?.[0]);
  } catch (error) {
    throw mapDbError(error);
  }
}

async function confirmarCanal(dados = {}, canal) {
  const sessaoId = validarIdSessao(dados.CadastroValidacaoId ?? dados.cadastroValidacaoId);
  const codigo = String(dados.Codigo ?? dados.codigo ?? '').trim();
  if (!/^\d{6}$/.test(codigo)) throw new HttpError(400, 'Código inválido. Use 6 dígitos.');

  try {
    const selected = await queryWithContext(null, (req) => {
      req.input('Id', sql.UniqueIdentifier, sessaoId);
      req.input('Canal', sql.NVarChar(20), canal);
    }, `
      SELECT TOP (1) v.Id,v.DestinoNormalizado,v.CodigoHash,v.CodigoSalt,v.ExpiraEm,
        v.Tentativas,v.MaxTentativas,v.Status,s.Status AS StatusSessao,s.ExpiraEm AS ExpiraSessao
      FROM dbo.FisioterapeutaCadastroSessoes s
      LEFT JOIN dbo.FisioterapeutaCadastroVerificacoes v
        ON v.CadastroSessaoId=s.Id AND v.Canal=@Canal
      WHERE s.Id=@Id;
    `);
    const row = selected.recordset?.[0];
    if (!row) throw new HttpError(404, 'Sessão de validação não encontrada.');
    if (!row.Id) throw new HttpError(404, 'Nenhum código pendente foi encontrado.');
    if (String(row.StatusSessao) === 'Consumido') throw new HttpError(409, 'Esta sessão já foi utilizada.');
    if (new Date(row.ExpiraSessao).getTime() <= Date.now()) throw new HttpError(410, 'Sessão expirada.');
    if (String(row.Status) === 'Confirmado') return obterStatus({ CadastroValidacaoId: sessaoId });
    if (String(row.Status) === 'Bloqueado') throw new HttpError(429, 'Código bloqueado. Solicite um novo.');
    if (!row.ExpiraEm || new Date(row.ExpiraEm).getTime() <= Date.now()) {
      throw new HttpError(410, 'Código expirado. Solicite um novo.');
    }

    const hash = calcularCodigoHash({
      salt: Buffer.isBuffer(row.CodigoSalt) ? row.CodigoSalt : Buffer.from(row.CodigoSalt),
      canal,
      codigo,
      destino: String(row.DestinoNormalizado),
    });
    const dbHash = Buffer.isBuffer(row.CodigoHash) ? row.CodigoHash : Buffer.from(row.CodigoHash);
    const correto = hash.length === dbHash.length && crypto.timingSafeEqual(hash, dbHash);

    if (!correto) {
      await queryWithContext(null, (req) => req.input('VerificacaoId', sql.BigInt, row.Id), `
        UPDATE dbo.FisioterapeutaCadastroVerificacoes
        SET Tentativas=Tentativas+1,
            Status=CASE WHEN Tentativas+1>=MaxTentativas THEN N'Bloqueado' ELSE N'Pendente' END,
            AtualizadoEm=SYSDATETIME()
        WHERE Id=@VerificacaoId AND Status=N'Pendente';
      `);
      throw new HttpError(400, 'Código incorreto.');
    }

    const confirmed = await queryWithContext(null, (req) => {
      req.input('SessaoId', sql.UniqueIdentifier, sessaoId);
      req.input('VerificacaoId', sql.BigInt, row.Id);
    }, `
      SET XACT_ABORT ON;
      BEGIN TRAN;
      UPDATE dbo.FisioterapeutaCadastroVerificacoes
      SET Status=N'Confirmado',ConfirmadoEm=SYSDATETIME(),OrigemConfirmacao=N'Codigo',
          CodigoHash=NULL,CodigoSalt=NULL,AtualizadoEm=SYSDATETIME()
      WHERE Id=@VerificacaoId AND CadastroSessaoId=@SessaoId AND Status=N'Pendente'
        AND ExpiraEm>=SYSDATETIME();
      IF @@ROWCOUNT<>1 THROW 50412,N'CADASTRO_CODE_ALREADY_PROCESSED',1;

      DECLARE @Ambos BIT=CASE WHEN EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
          WHERE CadastroSessaoId=@SessaoId AND Canal=N'Email' AND Status=N'Confirmado')
        AND EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
          WHERE CadastroSessaoId=@SessaoId AND Canal=N'Telefone' AND Status=N'Confirmado')
        THEN 1 ELSE 0 END;
      UPDATE dbo.FisioterapeutaCadastroSessoes
      SET Status=CASE WHEN @Ambos=1 THEN N'ContatosConfirmados' ELSE N'EmAndamento' END,
          ContatosConfirmadosEm=CASE WHEN @Ambos=1 THEN COALESCE(ContatosConfirmadosEm,SYSDATETIME()) ELSE NULL END,
          AtualizadoEm=SYSDATETIME()
      WHERE Id=@SessaoId AND Status<>N'Consumido';
      COMMIT;

      SELECT s.*,
        CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
          WHERE CadastroSessaoId=s.Id AND Canal=N'Email' AND Status=N'Confirmado') THEN 1 ELSE 0 END AS BIT) EmailConfirmado,
        CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
          WHERE CadastroSessaoId=s.Id AND Canal=N'Telefone' AND Status=N'Confirmado') THEN 1 ELSE 0 END AS BIT) TelefoneConfirmado
      FROM dbo.FisioterapeutaCadastroSessoes s WHERE s.Id=@SessaoId;
    `);
    return formatarResposta(confirmed.recordset?.[0]);
  } catch (error) {
    throw mapDbError(error);
  }
}

async function obterStatus(dados = {}) {
  const sessaoId = validarIdSessao(dados.CadastroValidacaoId ?? dados.cadastroValidacaoId);
  try {
    const result = await queryWithContext(null, (req) => req.input('Id', sql.UniqueIdentifier, sessaoId), `
      SELECT s.*,
        CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
          WHERE CadastroSessaoId=s.Id AND Canal=N'Email' AND Status=N'Confirmado') THEN 1 ELSE 0 END AS BIT) EmailConfirmado,
        CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.FisioterapeutaCadastroVerificacoes
          WHERE CadastroSessaoId=s.Id AND Canal=N'Telefone' AND Status=N'Confirmado') THEN 1 ELSE 0 END AS BIT) TelefoneConfirmado
      FROM dbo.FisioterapeutaCadastroSessoes s WHERE s.Id=@Id;
    `);
    const row = result.recordset?.[0];
    if (!row) throw new HttpError(404, 'Sessão de validação não encontrada.');
    if (String(row.Status) === 'Consumido') throw new HttpError(409, 'Esta sessão já foi utilizada.');
    if (['Expirado', 'Cancelado'].includes(String(row.Status)) || new Date(row.ExpiraEm).getTime() <= Date.now()) {
      throw new HttpError(410, 'Sessão de validação expirada. Inicie novamente.');
    }
    return formatarResposta(row);
  } catch (error) {
    throw mapDbError(error);
  }
}

const fisioterapeutaCadastroContatoService = {
  solicitarEmail,
  confirmarEmail: (dados) => confirmarCanal(dados, 'Email'),
  solicitarTelefone,
  confirmarTelefone: (dados) => confirmarCanal(dados, 'Telefone'),
  obterStatus,
};

export default fisioterapeutaCadastroContatoService;
