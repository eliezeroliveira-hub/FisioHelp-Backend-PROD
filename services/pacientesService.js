// services/pacientesService.js
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import path from 'path';
import { sql } from '../config/dbConfig.js';
import { log } from '../config/logger.js';
import { queryWithContext } from './_queryWithContext.js';
import { montarEmailVerificacaoPaciente } from './contatoTemplates.js';
import { solicitarVerificacaoContatoInterna } from './verificacaoContatoService.js';
import { authService } from './authService.js';
import { HttpError } from '../utils/httpError.js';
import { getContatoSecret } from '../utils/contactSecret.js';
import { isValidCPF, isValidEmail, normalizeEmail } from '../utils/identityValidators.js';
import { validatePasswordStrength } from '../utils/passwordPolicy.js';

function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normStr(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeDigits(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\D/g, '');
  return s ? s : null;
}

function isAdmin(usuario) {
  return String(usuario?.tipo || '').toLowerCase() === 'admin';
}

function httpError(message, statusCode) {
  return new HttpError(statusCode, message);
}

// DB: CK_Pacientes_Nome / CK_Pacientes_Genero / CK_Pacientes_CPF_Format / CK_Pacientes_Cep_Format
function validateNome(nome) {
  if (!nome) return;
  if (/\d/.test(nome)) throw httpError('Nome inválido: não pode conter números.', 400);
  if (/[^A-Za-zÀ-ÿ ]/.test(nome)) throw httpError('Nome inválido: use apenas letras e espaços.', 400);
}

function validateGenero(genero) {
  if (genero === null || genero === undefined) return;
  const g = String(genero).trim();
  if (!g) return;
  if (g !== 'Feminino' && g !== 'Masculino') {
    throw httpError("Genero inválido. Use 'Feminino' ou 'Masculino'.", 400);
  }
}

function normalizeCep(cep) {
  if (cep === null || cep === undefined) return null;
  let s = String(cep).trim();
  if (!s) return null;

  s = s.replace(/\s+/g, '');
  const digits = s.replace(/\D/g, '');

  if (digits.length !== 8) {
    throw httpError("CEP inválido. Use 8 dígitos (ex: '12345678') ou '12345-678'.", 400);
  }

  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

function normalizeDateInput(v, fieldName = 'DataNascimento') {
  if (v === null || v === undefined) return null;
  const raw = String(v).trim();
  if (!raw) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    const ok =
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === mo - 1 &&
      dt.getUTCDate() === d;
    if (!ok) throw httpError(`${fieldName} inválida.`, 400);
    return new Date(raw);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw httpError(`${fieldName} inválida.`, 400);
  }
  return parsed;
}


// --- Verificação de contato (Email/Telefone) ---
// Normalize destino
// Brasil (dev): normaliza para E.164 +55XXXXXXXXXXX
function normalizeTelefoneE164(telefone) {
  const digits = String(telefone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  // fallback: mantém com +
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function normalizeDestinoContato(canalNormalizado, destinoRaw) {
  if (!destinoRaw) return '';
  if (canalNormalizado === 'Email') return normalizeEmail(destinoRaw);
  return normalizeTelefoneE164(destinoRaw); // Telefone
}

const VERIFICACAO_CONTATO_COOLDOWN_SEGUNDOS = 60;

function gerarSalt16() {
  return crypto.randomBytes(16);
}


function normalizeCanalContato(canalRaw) {
  const c = String(canalRaw ?? '').trim().toLowerCase();
  if (!c) return null;
  if (c === 'email' || c === 'e-mail') return 'Email';
  if (c === 'telefone' || c === 'tel' || c === 'phone') return 'Telefone';
  return null;
}


function gerarCodigo6() {
  // 6 dígitos (CSPRNG), incluindo 000000..999999
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function validateEmail(email) {
  if (email === null || email === undefined) return;
  const e = String(email).trim();
  if (!e) return;
  if (!isValidEmail(e)) {
    throw httpError('E-mail inválido.', 400);
  }
}

function validateLocalidade(value, fieldName) {
  if (value === null || value === undefined) return;
  const v = String(value).trim();
  if (!v) return;
  if (/[^A-Za-zÀ-ÿ\s.'-]/.test(v)) {
    throw httpError(`${fieldName} inválido: use apenas letras, espaços, apóstrofo, ponto e hífen.`, 400);
  }
}

function calcularCodigoHash({ salt, canal, codigo, destinoNormalizado }) {
  const saltHex = Buffer.isBuffer(salt) ? salt.toString('hex') : String(salt || '');
  const canalNorm = normalizeCanalContato(canal) || String(canal || '');
  const base = `${saltHex}:${String(canalNorm)}:${String(codigo)}:${String(destinoNormalizado)}`;
  return crypto.createHmac('sha256', getContatoSecret()).update(base, 'utf8').digest(); // Buffer(32)
}



function getSqlErrText(e) {
  const parts = [
    e?.message,
    e?.originalError?.message,
    e?.originalError?.info?.message,
    ...(Array.isArray(e?.precedingErrors) ? e.precedingErrors.map(x => x?.message) : []),
  ].filter(Boolean);

  return parts.join(' | ');
}

function mapUniqueError(e) {
  const oauthErr = authService.mapOAuthCadastroDbError?.(e);
  if (oauthErr) return oauthErr;

  const num =
    e?.number ??
    e?.originalError?.info?.number ??
    e?.originalError?.number;

  if (num !== 2627 && num !== 2601) return e;

  const raw = getSqlErrText(e);
  const msg = String(raw || '');
  const msgLower = msg.toLowerCase();

  // 1) Mapeamento por nomes reais de índice/constraint (mais estável)
  const EMAIL_UNIQUE_IDS = [
    'uq_usuariosemailsunicos_emailnormalizado',
    'uq__paciente__a9d10534031fdd2c',
  ];
  const CPF_UNIQUE_IDS = [
    'uq__paciente__c1f89731b0dbc1ff',
  ];

  if (EMAIL_UNIQUE_IDS.some((id) => msgLower.includes(id))) {
    return httpError('E-mail já cadastrado.', 409);
  }
  if (CPF_UNIQUE_IDS.some((id) => msgLower.includes(id))) {
    return httpError('CPF já cadastrado.', 409);
  }

  // 2) Tenta extrair o "duplicate key value"
  // (inglês) The duplicate key value is (xxx)
  // (pt) O valor da chave duplicada é (xxx)
  const m =
    msgLower.match(/duplicate key value is \(([^)]+)\)/i) ||
    msgLower.match(/valor da chave duplicada .* \(([^)]+)\)/i);

  if (m?.[1]) {
    const keyVal = m[1].trim();
    if (keyVal.includes('@')) {
      return httpError('E-mail já cadastrado.', 409);
    }
    const digits = keyVal.replace(/\D/g, '');

    // 11 dígitos é ambíguo no BR (CPF e telefone celular).
    // Usa pistas da mensagem SQL para mapear corretamente.
    if (digits.length === 11) {
      if (
        msgLower.includes('telefone') ||
        msgLower.includes('telefonenormalizado') ||
        msgLower.includes('usuariostelefonesunicos')
      ) {
        return httpError('Telefone já cadastrado.', 409);
      }
      if (msgLower.includes('cpf') || msgLower.includes('pacientes')) {
        return httpError('CPF já cadastrado.', 409);
      }
      return httpError('CPF ou Telefone já cadastrado.', 409);
    }

    if (digits.length === 10 || digits.length === 12 || digits.length === 13) {
      return httpError('Telefone já cadastrado.', 409);
    }
  }

  // 3) Fallback mínimo e conservador
  if (msgLower.includes('emailnormalizado') || msgLower.includes('usuariosemailsunicos')) {
    return httpError('E-mail já cadastrado.', 409);
  }
  if (msgLower.includes('cpf')) return httpError('CPF já cadastrado.', 409);

  return httpError('Registro duplicado (violação de chave única).', 409);
}


export const pacientesService = {
  async buscarPorId(usuario, id) {
    const pid = toInt(id);
    if (!pid) throw httpError('Id inválido.', 400);

    const result = await queryWithContext(
      usuario,
      (req) => req.input('Id', sql.Int, pid),
      `
        SELECT
          p.Id AS PacienteId,
          p.Nome,
          p.CPF,
          p.Email,
          p.Telefone,
          p.DataNascimento,
          p.DataCadastro,
          p.Ativo,
          p.Cidade,
          p.Estado,
          p.Naturalidade,
          p.EstadoCivil,
          p.Genero,
          p.Profissao,
          p.EnderecoComercial,
          p.EnderecoResidencial,
          p.Cep,
          p.CepComercial,
          p.BairroResidencial,
          p.BairroComercial,
          p.ComplementoResidencial,
          p.ComplementoComercial,
          p.CPFValido,
          p.EmailVerificado,
          p.TelefoneVerificado,
          CASE
            WHEN p.CPFValido = 1 AND p.EmailVerificado = 1 AND p.TelefoneVerificado = 1
              THEN 1
            ELSE 0
          END AS ContaVerificada
        FROM dbo.Pacientes AS p
        WHERE p.Id = @Id;
      `,
      { requireContext: true }
    );

    const paciente = result.recordset?.[0] || null;
    if (paciente) delete paciente.SenhaHash;
    return paciente;
  },

  // Cadastro público
  async criar(dados) {
    try {
      const Nome = normStr(dados?.Nome, 300);
      const Email = normStr(dados?.Email, 300);
      const CPF = normalizeDigits(dados?.CPF);
      const Telefone = normalizeDigits(dados?.Telefone);
      const DataNascimento = normalizeDateInput(dados?.DataNascimento ?? null, 'DataNascimento');
      const Senha = dados?.Senha;

      const Cidade = normStr(dados?.Cidade, 400);
      const Estado = normStr(dados?.Estado, 400);
      const Naturalidade = normStr(dados?.Naturalidade, 240);
      const EstadoCivil = normStr(dados?.EstadoCivil, 120);
      const Genero = normStr(dados?.Genero, 40);
      const Profissao = normStr(dados?.Profissao, 240);
      const EnderecoComercial = normStr(dados?.EnderecoComercial, 1600);
      const EnderecoResidencial = normStr(dados?.EnderecoResidencial, 1600);
      const Cep = normalizeCep(dados?.Cep);
      const CepComercial = normalizeCep(dados?.CepComercial);
      const BairroResidencial = normStr(dados?.BairroResidencial, 200);
      const BairroComercial = normStr(dados?.BairroComercial, 200);
      const ComplementoResidencial = normStr(dados?.ComplementoResidencial, 400);
      const ComplementoComercial = normStr(dados?.ComplementoComercial, 400);

      if (!Nome || !Email || !CPF || !Senha) {
        throw httpError('Campos obrigatórios: Nome, Email, CPF e Senha.', 400);
      }
      validatePasswordStrength(Senha);
      validateEmail(Email);
      if (CPF.length !== 11 || !isValidCPF(CPF)) {
        throw httpError('CPF inválido.', 400);
      }
      if (Telefone && (Telefone.length < 10 || Telefone.length > 11)) {
        throw httpError('Telefone inválido: use DDD + número (10 ou 11 dígitos).', 400);
      }
      validateNome(Nome);
      validateGenero(Genero);
      validateLocalidade(Cidade, 'Cidade');
      validateLocalidade(Estado, 'Estado');

      const cpfValido = 1;

      const senhaHash = await bcrypt.hash(String(Senha), 12);
      const oauthCadastro = authService.validarOAuthCadastroToken(dados?.oauthCadastroToken ?? dados?.OAuthCadastroToken ?? null);

      const result = await queryWithContext(
        null,
        (req) => req
          .input('Nome', sql.NVarChar(300), Nome)
          .input('CPF', sql.NVarChar(40), CPF)
          .input('Email', sql.NVarChar(300), Email)
          .input('Telefone', sql.NVarChar(60), Telefone)
          .input('DataNascimento', sql.Date, DataNascimento)
          .input('SenhaHash', sql.NVarChar(256), senhaHash)
          .input('CPFValido', sql.Bit, cpfValido)
          .input('Cidade', sql.NVarChar(400), Cidade)
          .input('Estado', sql.NVarChar(400), Estado)
          .input('Naturalidade', sql.NVarChar(240), Naturalidade)
          .input('EstadoCivil', sql.NVarChar(120), EstadoCivil)
          .input('Genero', sql.NVarChar(40), Genero)
          .input('Profissao', sql.NVarChar(240), Profissao)
          .input('EnderecoComercial', sql.NVarChar(1600), EnderecoComercial)
          .input('EnderecoResidencial', sql.NVarChar(1600), EnderecoResidencial)
          .input('Cep', sql.NVarChar(18), Cep)
          .input('CepComercial', sql.NVarChar(18), CepComercial)
          .input('BairroResidencial', sql.NVarChar(200), BairroResidencial)
          .input('BairroComercial', sql.NVarChar(200), BairroComercial)
          .input('ComplementoResidencial', sql.NVarChar(400), ComplementoResidencial)
          .input('ComplementoComercial', sql.NVarChar(400), ComplementoComercial)
          .input('OAuthJti', sql.NVarChar(36), oauthCadastro?.jti || null)
          .input('OAuthProvedor', sql.NVarChar(30), oauthCadastro?.provider || null)
          .input('OAuthSubject', sql.NVarChar(255), oauthCadastro?.subject || null),
        `
        SET XACT_ABORT ON;

        BEGIN TRY
          BEGIN TRAN;

          DECLARE @OAuthTokenId UNIQUEIDENTIFIER = TRY_CONVERT(UNIQUEIDENTIFIER, @OAuthJti);
          DECLARE @OAuthEmailAtual NVARCHAR(300) = NULL;
          DECLARE @OAuthEmailRelay BIT = 0;
          DECLARE @OAuthNomeAtual NVARCHAR(300) = NULL;

          IF @OAuthJti IS NOT NULL
          BEGIN
            IF @OAuthTokenId IS NULL
              THROW 50121, N'OAUTH_SIGNUP_TOKEN_INVALID', 1;

            IF OBJECT_ID(N'dbo.OAuthCadastroTokens', N'U') IS NULL
              THROW 50120, N'OAUTH_SIGNUP_TABLE_MISSING', 1;

            IF OBJECT_ID(N'dbo.UsuarioOAuthIdentidades', N'U') IS NULL
              THROW 50120, N'OAUTH_SIGNUP_TABLE_MISSING', 1;

            DECLARE @OAuthTokenEncontrado BIT = 0;
            DECLARE @OAuthExpiraEm DATETIME2(3) = NULL;
            DECLARE @OAuthUsadoEm DATETIME2(3) = NULL;
            DECLARE @OAuthUsuarioTipo NVARCHAR(30) = NULL;
            DECLARE @OAuthUsuarioId INT = NULL;

            SELECT TOP (1)
              @OAuthTokenEncontrado = 1,
              @OAuthEmailAtual = Email,
              @OAuthEmailRelay = ISNULL(EmailRelay, 0),
              @OAuthNomeAtual = Nome,
              @OAuthExpiraEm = ExpiraEm,
              @OAuthUsadoEm = UsadoEm,
              @OAuthUsuarioTipo = UsuarioTipo,
              @OAuthUsuarioId = UsuarioId
            FROM dbo.OAuthCadastroTokens WITH (UPDLOCK, HOLDLOCK)
            WHERE Jti = @OAuthTokenId
              AND Provedor = @OAuthProvedor
              AND Subject = @OAuthSubject;

            IF @OAuthTokenEncontrado = 0
              THROW 50121, N'OAUTH_SIGNUP_TOKEN_INVALID', 1;

            IF @OAuthUsadoEm IS NOT NULL
            BEGIN
              IF @OAuthUsuarioId IS NOT NULL AND @OAuthUsuarioTipo = N'Paciente'
                THROW 50125, N'CADASTRO_JA_CONCLUIDO', 1;

              THROW 50123, N'OAUTH_SIGNUP_TOKEN_USED', 1;
            END

            IF @OAuthExpiraEm <= SYSDATETIME()
              THROW 50122, N'OAUTH_SIGNUP_TOKEN_EXPIRED', 1;

            IF EXISTS (
              SELECT 1
              FROM dbo.UsuarioOAuthIdentidades WITH (UPDLOCK, HOLDLOCK)
              WHERE Provedor = @OAuthProvedor
                AND Subject = @OAuthSubject
                AND RevogadoEm IS NULL
            )
              THROW 50124, N'OAUTH_IDENTITY_ALREADY_LINKED', 1;
          END

          INSERT INTO dbo.Pacientes
          (Nome, CPF, Email, Telefone, DataNascimento, SenhaHash,
          CPFValido,
          Cidade, Estado, Naturalidade, EstadoCivil, Genero, Profissao,
          EnderecoComercial, EnderecoResidencial, Cep, CepComercial,
          BairroResidencial, BairroComercial,
          ComplementoResidencial, ComplementoComercial)
        VALUES
          (@Nome, @CPF, @Email, @Telefone, @DataNascimento, @SenhaHash,
          @CPFValido,
          @Cidade, @Estado, @Naturalidade, @EstadoCivil, @Genero, @Profissao,
          @EnderecoComercial, @EnderecoResidencial, @Cep, @CepComercial,
          @BairroResidencial, @BairroComercial,
          @ComplementoResidencial, @ComplementoComercial);

          DECLARE @NewId INT = CAST(SCOPE_IDENTITY() AS INT);

          IF @OAuthJti IS NOT NULL
          BEGIN
            INSERT INTO dbo.UsuarioOAuthIdentidades
              (Provedor, Subject, UsuarioTipo, UsuarioId, EmailAtual, EmailRelay, NomeAtual, UltimoLoginEm)
            VALUES
              (@OAuthProvedor, @OAuthSubject, N'Paciente', @NewId, @OAuthEmailAtual, @OAuthEmailRelay, COALESCE(@OAuthNomeAtual, @Nome), SYSDATETIME());

            UPDATE dbo.OAuthCadastroTokens
            SET UsadoEm = SYSDATETIME(),
                UsuarioTipo = N'Paciente',
                UsuarioId = @NewId,
                AtualizadoEm = SYSDATETIME()
            WHERE Jti = @OAuthTokenId
              AND UsadoEm IS NULL;

            IF @@ROWCOUNT <> 1
              THROW 50123, N'OAUTH_SIGNUP_TOKEN_USED', 1;
          END

          COMMIT;

        SELECT
          p.Id,
          p.Nome,
          p.CPF,
          p.Email,
          p.Telefone,
          p.DataNascimento,
          p.DataCadastro,
          p.Ativo,
          p.TipoCadastro,
          p.CPFValido,
          p.IsBloqueado,
          p.Cidade,
          p.Estado,
          p.Naturalidade,
          p.EstadoCivil,
          p.Genero,
          p.Profissao,
          p.EnderecoComercial,
          p.EnderecoResidencial,
          p.Cep,
          p.CepComercial,
          p.BairroResidencial,
          p.BairroComercial,
          p.ComplementoResidencial,
          p.ComplementoComercial,
          p.EmailVerificado,
          p.TelefoneVerificado,
          p.EmailVerificadoEm,
          p.TelefoneVerificadoEm
        FROM dbo.Pacientes p
        WHERE p.Id = @NewId;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          THROW;
        END CATCH

        `
      );

      const novo = result.recordset?.[0] || null;
      if (novo) delete novo.SenhaHash;
      if (novo?.Id) {
        novo.verificacaoEmailEnviada = false;
        void solicitarVerificacaoContatoInterna({
            usuarioTipo: 'Paciente',
            usuarioId: novo.Id,
            canal: 'Email',
            expiraEmMinutos: 10,
            montarConteudo: ({ codigo, usuario, expiraEmMinutos }) => montarEmailVerificacaoPaciente({
              nome: usuario?.Nome || novo.Nome,
              codigo,
              expiraEmMinutos,
            }),
        })
          .then((verificacao) => {
            log('info', 'Verificação de e-mail solicitada no cadastro de paciente', {
              pacienteId: novo.Id,
              destino: verificacao?.destinoMascarado,
            });
          })
          .catch((err) => {
          log('warn', 'Falha ao enviar e-mail de verificação no cadastro de paciente', {
            pacienteId: novo.Id,
            erro: err?.message,
          });
          });
      }
      return novo;
    } catch (e) {
      throw mapUniqueError(e);
    }
  },

  async ativarPreCadastro(payload = {}, reqLike = null) {
    const CPF = normalizeDigits(payload?.cpf ?? payload?.CPF);
    const Email = normalizeEmail(payload?.email ?? payload?.Email);
    const NovaSenha = String(payload?.novaSenha ?? payload?.NovaSenha ?? payload?.senha ?? payload?.Senha ?? '');

    if (!CPF || !Email || !NovaSenha) {
      throw httpError('Campos obrigatórios: CPF, e-mail e nova senha.', 400);
    }
    if (CPF.length !== 11 || !isValidCPF(CPF)) {
      throw httpError('CPF inválido.', 400);
    }
    validateEmail(Email);
    validatePasswordStrength(NovaSenha);

    const senhaHash = await bcrypt.hash(NovaSenha, 12);

    try {
      const ativacao = await queryWithContext(
        null,
        (req) => req
          .input('CPF', sql.NVarChar(40), CPF)
          .input('Email', sql.NVarChar(300), Email)
          .input('SenhaHash', sql.NVarChar(256), senhaHash),
        `
          SET XACT_ABORT ON;
          BEGIN TRAN;

          DECLARE @PacienteId INT;
          DECLARE @OrigemCadastro NVARCHAR(40);
          DECLARE @Ativo BIT;
          DECLARE @IsBloqueado BIT;

          SELECT TOP 1
            @PacienteId = Id,
            @OrigemCadastro = OrigemCadastro,
            @Ativo = Ativo,
            @IsBloqueado = IsBloqueado
          FROM dbo.Pacientes WITH (UPDLOCK, HOLDLOCK)
          WHERE CPF = @CPF
            AND LOWER(LTRIM(RTRIM(Email))) = @Email;

          IF @PacienteId IS NULL
            THROW 52010, N'Pré-cadastro não encontrado para os dados informados.', 1;

          IF ISNULL(@Ativo, 0) = 0
            THROW 52011, N'Conta de paciente desativada.', 1;

          IF ISNULL(@IsBloqueado, 0) = 1
            THROW 52012, N'Conta de paciente bloqueada.', 1;

          IF @OrigemCadastro = N'PreCadastroFisioAtivado'
            THROW 52013, N'Este pré-cadastro já foi ativado. Entre com seu CPF ou e-mail e senha.', 1;

          IF @OrigemCadastro = N'Direto'
            THROW 52014, N'Este CPF e e-mail já pertencem a uma conta criada diretamente, não a um pré-cadastro feito por fisioterapeuta. Entre pelo login do app.', 1;

          IF ISNULL(@OrigemCadastro, N'') <> N'PreCadastroFisio'
            THROW 52015, N'Esta conta não está disponível para ativação de pré-cadastro. Entre pelo login do app.', 1;

          UPDATE dbo.Pacientes
          SET SenhaHash = @SenhaHash,
              OrigemCadastro = N'PreCadastroFisioAtivado'
          WHERE Id = @PacienteId
            AND OrigemCadastro = N'PreCadastroFisio';

          SELECT TOP 1
            Id,
            Nome,
            Email,
            CPF,
            OrigemCadastro
          FROM dbo.Pacientes
          WHERE Id = @PacienteId;

          COMMIT;
        `
      );

      const row = ativacao.recordset?.[0];
      if (!row?.Id) {
        throw httpError('Não foi possível ativar o pré-cadastro.', 500);
      }

      return authService.login({ cpf: CPF, senha: NovaSenha }, reqLike);
    } catch (e) {
      const msg = String(e?.message || '');
      if (
        msg.includes('Pré-cadastro não encontrado') ||
        msg.includes('Conta de paciente') ||
        msg.includes('pré-cadastro já foi ativado') ||
        msg.includes('conta criada diretamente') ||
        msg.includes('não está disponível para ativação de pré-cadastro')
      ) {
        throw httpError(msg, msg.includes('bloqueada') || msg.includes('desativada') ? 403 : 400);
      }
      throw e;
    }
  },

  // Atualiza perfil (whitelist) - NÃO altera senha aqui
  async atualizar(usuario, id, dados) {
    try {
      const pid = toInt(id);
      if (!pid) throw httpError('Id inválido.', 400);

      if (dados?.Senha !== undefined || dados?.SenhaHash !== undefined) {
        throw httpError('Use o endpoint /pacientes/:id/senha para alterar senha.', 400);
      }

      const setParts = [];
      const inputs = [];

      const allowed = {
        Nome: (v) => {
          const val = normStr(v, 300);
          validateNome(val);
          return { type: sql.NVarChar(300), value: val };
        },
        Email: (v) => {
          const val = normStr(v, 300);
          validateEmail(val);
          return { type: sql.NVarChar(300), value: val };
        },
        Telefone: (v) => {
          const tel = normalizeDigits(v);
          if (tel && (tel.length < 10 || tel.length > 11)) {
            throw httpError('Telefone inválido: use DDD + número (10 ou 11 dígitos).', 400);
          }
          return { type: sql.NVarChar(60), value: tel };
        },
        DataNascimento: (v) => ({ type: sql.Date, value: normalizeDateInput(v, 'DataNascimento') }),

        Cidade: (v) => {
          const val = normStr(v, 400);
          validateLocalidade(val, 'Cidade');
          return { type: sql.NVarChar(400), value: val };
        },
        Estado: (v) => {
          const val = normStr(v, 400);
          validateLocalidade(val, 'Estado');
          return { type: sql.NVarChar(400), value: val };
        },
        Naturalidade: (v) => ({ type: sql.NVarChar(240), value: normStr(v, 240) }),
        EstadoCivil: (v) => ({ type: sql.NVarChar(120), value: normStr(v, 120) }),
        Genero: (v) => {
          const val = normStr(v, 40);
          validateGenero(val);
          return { type: sql.NVarChar(40), value: val };
        },
        Profissao: (v) => ({ type: sql.NVarChar(240), value: normStr(v, 240) }),
        EnderecoComercial: (v) => ({ type: sql.NVarChar(1600), value: normStr(v, 1600) }),
        EnderecoResidencial: (v) => ({ type: sql.NVarChar(1600), value: normStr(v, 1600) }),
        Cep: (v) => ({ type: sql.NVarChar(18), value: normalizeCep(v) }),
        CepComercial: (v) => ({ type: sql.NVarChar(18), value: normalizeCep(v) }),
        BairroResidencial: (v) => ({ type: sql.NVarChar(200), value: normStr(v, 200) }),
        BairroComercial: (v) => ({ type: sql.NVarChar(200), value: normStr(v, 200) }),
        ComplementoResidencial: (v) => ({ type: sql.NVarChar(400), value: normStr(v, 400) }),
        ComplementoComercial: (v) => ({ type: sql.NVarChar(400), value: normStr(v, 400) }),
      };

      if (isAdmin(usuario)) {
        allowed.CPF = (v) => {
          const cpf = normalizeDigits(v);
          if (!cpf || cpf.length !== 11) throw httpError('CPF inválido: deve ter 11 dígitos.', 400);
          const cpfValido = isValidCPF(cpf) ? 1 : 0;
          return { type: sql.NVarChar(40), value: cpf, cpfValido };
        };
      }

      for (const [key, parser] of Object.entries(allowed)) {
        if (dados?.[key] !== undefined) {
          const parsed = parser(dados[key]);
          const { type, value } = parsed;

          setParts.push(`${key} = @${key}`);
          inputs.push({ key, type, value });

          // Se CPF foi atualizado (Admin), também atualiza CPFValido automaticamente
          if (key === 'CPF' && parsed?.cpfValido !== undefined) {
            setParts.push(`CPFValido = @CPFValido`);
            inputs.push({ key: 'CPFValido', type: sql.Bit, value: parsed.cpfValido ? 1 : 0 });
          }

          if (key === 'Email') {
            const emailAlterado = `
              LOWER(LTRIM(RTRIM(ISNULL(Email, N'')))) <>
              LOWER(LTRIM(RTRIM(ISNULL(@Email, N''))))
            `;
            setParts.push(
              `EmailVerificado = CASE WHEN ${emailAlterado} THEN 0 ELSE EmailVerificado END`,
              `EmailVerificadoEm = CASE WHEN ${emailAlterado} THEN NULL ELSE EmailVerificadoEm END`
            );
          }
          if (key === 'Telefone') {
            const telefoneAlterado = `
              ISNULL(Telefone, N'') <> ISNULL(@Telefone, N'')
            `;
            setParts.push(
              `TelefoneVerificado = CASE
                WHEN ${telefoneAlterado} THEN 0
                ELSE TelefoneVerificado
              END`,
              `TelefoneVerificadoEm = CASE
                WHEN ${telefoneAlterado} THEN NULL
                ELSE TelefoneVerificadoEm
              END`
            );
          }
        }
      }
      if (setParts.length === 0) throw httpError('Nenhum campo permitido fornecido para atualização.', 400);

      const result = await queryWithContext(
        usuario,
        (req) => {
          req.input('Id', sql.Int, pid);
          for (const i of inputs) req.input(i.key, i.type, i.value);
        },
        `
          UPDATE dbo.Pacientes
          SET ${setParts.join(', ')}
          WHERE Id = @Id;

          SELECT
            p.Id AS PacienteId,
            p.Nome,
            p.CPF,
            p.Email,
            p.Telefone,
            p.DataNascimento,
            p.DataCadastro,
            p.Ativo,
            p.Cidade,
            p.Estado,
            p.Naturalidade,
            p.EstadoCivil,
            p.Genero,
          p.Profissao,
          p.EnderecoComercial,
          p.EnderecoResidencial,
          p.Cep,
          p.CepComercial,
          p.BairroResidencial,
          p.BairroComercial,
          p.ComplementoResidencial,
          p.ComplementoComercial,
          p.CPFValido,
          p.EmailVerificado,
          p.TelefoneVerificado,
          CASE
            WHEN p.CPFValido = 1 AND p.EmailVerificado = 1 AND p.TelefoneVerificado = 1
              THEN 1
            ELSE 0
          END AS ContaVerificada
          FROM dbo.Pacientes p
          WHERE p.Id = @Id;
        `,
        { requireContext: true }
      );

      const atualizado = result.recordset?.[0] || null;
      if (atualizado) delete atualizado.SenhaHash;
      return atualizado;
    } catch (e) {
      throw mapUniqueError(e);
    }
  },

  // Confiabilidade
  async obterConfiabilidade(usuario, id) {
    const pid = toInt(id);
    if (!pid) throw httpError('Id inválido.', 400);

    const result = await queryWithContext(
      usuario,
      (req) => req.input('Id', sql.Int, pid),
      `
        SELECT TOP 1
          p.Id AS PacienteId,
          p.CPFValido,
          p.EmailVerificado,
          p.TelefoneVerificado,
          CASE WHEN p.CPFValido = 1 AND p.EmailVerificado = 1 AND p.TelefoneVerificado = 1 THEN 1 ELSE 0 END AS Confiavel
        FROM dbo.Pacientes p
        WHERE p.Id = @Id;

        SELECT
          dp.Id AS DocumentoPacienteId,
          dp.ConsultaId,
          dp.TipoDocumento,
          dp.CaminhoArquivo,
          c.FisioterapeutaId,
          c.DataHora AS DataConsulta,
          c.Status AS StatusConsulta,
          fmp.Nome AS NomeFisioterapeuta,
          fmp.Especialidade AS EspecialidadeFisioterapeuta,
          fmp.FotoPerfilUrl
        FROM dbo.DocumentosPacientes dp
        LEFT JOIN dbo.Consultas c
          ON c.Id = dp.ConsultaId
        LEFT JOIN dbo.FisioterapeutasMetricasPublicas fmp
          ON fmp.FisioterapeutaId = c.FisioterapeutaId
        WHERE dp.PacienteId = @Id
          AND dp.TipoDocumento = N'AutorizacaoAtendimento'
        ORDER BY
          CASE WHEN c.DataHora IS NULL THEN 1 ELSE 0 END ASC,
          c.DataHora DESC,
          dp.Id DESC;
      `,
      { requireContext: true }
    );

    const row = result.recordsets?.[0]?.[0] || result.recordset?.[0] || null;
    if (!row) return null;

    const cpfValido = row.CPFValido === 1 || row.CPFValido === true;
    const emailVerificado = row.EmailVerificado === 1 || row.EmailVerificado === true;
    const telefoneVerificado = row.TelefoneVerificado === 1 || row.TelefoneVerificado === true;
    const confiavel = cpfValido && emailVerificado && telefoneVerificado;
    const percentual = Math.round(
      ([cpfValido, emailVerificado, telefoneVerificado].filter(Boolean).length / 3) * 100
    );

    const documentosRows = Array.isArray(result.recordsets?.[1]) ? result.recordsets[1] : [];
    const pedidosMedicos = documentosRows.map((doc) => {
      const documentoPacienteId = toInt(doc.DocumentoPacienteId);
      const consultaId = toInt(doc.ConsultaId);
      const fisioterapeutaId = toInt(doc.FisioterapeutaId);
      const caminhoArquivo = doc.CaminhoArquivo ? String(doc.CaminhoArquivo) : null;
      const nomeArquivo =
        caminhoArquivo && caminhoArquivo.trim()
          ? path.basename(caminhoArquivo.trim())
          : `pedido-medico-${documentoPacienteId || 'arquivo'}.pdf`;

      return {
        DocumentoPacienteId: documentoPacienteId,
        ConsultaId: consultaId,
        FisioterapeutaId: fisioterapeutaId,
        NomeFisioterapeuta: doc.NomeFisioterapeuta ?? null,
        EspecialidadeFisioterapeuta: doc.EspecialidadeFisioterapeuta ?? null,
        FotoPerfilUrl: doc.FotoPerfilUrl ?? null,
        DataConsulta: doc.DataConsulta ?? null,
        StatusConsulta: doc.StatusConsulta ?? null,
        TipoDocumento: doc.TipoDocumento ?? null,
        NomeArquivo: nomeArquivo,
        VisualizarUrl: documentoPacienteId
          ? `/api/arquivos/pedidos-medicos/${documentoPacienteId}/visualizar`
          : null,
        DownloadUrl: documentoPacienteId
          ? `/api/arquivos/pedidos-medicos/${documentoPacienteId}/download`
          : null,
      };
    });

    return {
      sucesso: true,
      pacienteId: row.PacienteId,
      cpfValido: cpfValido ? 1 : 0,
      emailVerificado: emailVerificado ? 1 : 0,
      telefoneVerificado: telefoneVerificado ? 1 : 0,
      confiavel: confiavel ? 1 : 0,
      percentual,
      criterios: {
        cpfValido: cpfValido ? 1 : 0,
        emailVerificado: emailVerificado ? 1 : 0,
        telefoneVerificado: telefoneVerificado ? 1 : 0,
      },
      documentos: {
        total: pedidosMedicos.length,
        pedidosMedicos,
      },
    };
  },

  // Alterar senha (dedicado)
  async alterarSenha(usuario, id, payload) {
    const pid = toInt(id);
    if (!pid) throw httpError('Id inválido.', 400);

    const senhaAtual = payload?.senhaAtual ?? payload?.SenhaAtual ?? null;
    const novaSenha = payload?.novaSenha ?? payload?.NovaSenha ?? null;

    const nova = String(novaSenha || '');
    validatePasswordStrength(nova);

    const r = await queryWithContext(
      usuario,
      (req) => req.input('Id', sql.Int, pid),
      `SELECT TOP 1 SenhaHash FROM dbo.Pacientes WHERE Id = @Id;`,
      { requireContext: true }
    );

    const row = r.recordset?.[0];
    if (!row?.SenhaHash) throw httpError('Paciente não encontrado.', 404);

    if (!isAdmin(usuario)) {
      if (!senhaAtual) throw httpError('senhaAtual é obrigatória.', 400);
      const ok = await bcrypt.compare(String(senhaAtual), String(row.SenhaHash));
      if (!ok) throw httpError('Senha atual incorreta.', 401);
    }

    const novoHash = await bcrypt.hash(nova, 12);

    await queryWithContext(
      usuario,
      (req) => req.input('Id', sql.Int, pid).input('SenhaHash', sql.NVarChar(256), novoHash),
      `UPDATE dbo.Pacientes SET SenhaHash = @SenhaHash WHERE Id = @Id;`,
      { requireContext: true }
    );

    return { sucesso: true, mensagem: 'Senha alterada com sucesso.' };
  },


  /**
   * Registra Pedido Médico (upload multipart via /api/arquivos/pedidos-medicos/:consultaId)
   * Observação: por enquanto grava como TipoDocumento='AutorizacaoAtendimento' para respeitar o CHECK atual.
   */
  async registrarPedidoMedico(usuario, { consultaId, caminhoArquivo } = {}) {
    const cid = toInt(consultaId);
    if (!cid) throw httpError('consultaId inválido.', 400);

    const rel = String(caminhoArquivo || '').trim().replace(/\\/g, '/');
    if (!rel) throw httpError('Caminho do arquivo é obrigatório.', 400);

    if (!rel.toLowerCase().startsWith('pedidos-medicos/')) {
      throw httpError('CaminhoArquivo inválido.', 400);
    }

    // Bloqueia traversal (ex.: pedidos-medicos/../outros)
    const parts = rel.split('/').filter(Boolean);
    if (parts.some((seg) => seg === '..' || seg.includes('..'))) {
      throw httpError('Path traversal bloqueado.', 400);
    }

    const usuarioId = toInt(usuario?.id);
    if (!usuarioId) throw httpError('Não autenticado.', 401);

    const c = await queryWithContext(
      usuario,
      (req) => req.input('ConsultaId', sql.Int, cid),
      `
        SELECT TOP 1
          Id,
          PacienteId,
          Status
        FROM dbo.Consultas
        WHERE Id = @ConsultaId;
      `,
      { requireContext: true }
    );

    const consulta = c.recordset?.[0];
    if (!consulta) throw httpError('Consulta não encontrada.', 404);

    if (!isAdmin(usuario) && Number(consulta.PacienteId) !== Number(usuarioId)) {
      throw httpError('Acesso negado.', 403);
    }

    const statusConsulta = String(consulta.Status || '').trim();
    const statusPermitidos = new Set(['Aguardando', 'Confirmada']);

    if (!statusPermitidos.has(statusConsulta)) {
      throw httpError(
        "Pedido médico só pode ser enviado para consultas ativas (Aguardando ou Confirmada).",
        409
      );
    }

    const ins = await queryWithContext(
      usuario,
      (req) => {
        req.input('PacienteId', sql.Int, Number(consulta.PacienteId));
        req.input('ConsultaId', sql.Int, cid);

        // Por constraint atual: grava como AutorizacaoAtendimento
        req.input('TipoDocumento', sql.NVarChar(100), 'AutorizacaoAtendimento');

        req.input('CaminhoArquivo', sql.NVarChar(1000), rel);
      },
      `
        INSERT INTO dbo.DocumentosPacientes (
          PacienteId,
          TipoDocumento,
          CaminhoArquivo,
          ConsultaId
        )
        VALUES (
          @PacienteId,
          @TipoDocumento,
          @CaminhoArquivo,
          @ConsultaId
        );

        DECLARE @NovoId INT = CAST(SCOPE_IDENTITY() AS INT);
        SELECT @NovoId AS Id;
      `,
      { requireContext: true }
    );

    const documentoPacienteId = ins.recordset?.[0]?.Id || null;

    return {
      sucesso: true,
      documentoPacienteId,
      id: documentoPacienteId,
      consultaId: cid,
      caminhoArquivo: rel
    };
  },

  // Soft delete
  async remover(usuario, id, payload = {}) {
    const pid = toInt(id);
    if (!pid) throw httpError('Id inválido.', 400);

    const senha = payload?.senha ?? payload?.Senha ?? null;

    const check = await queryWithContext(
      usuario,
      (req) => req.input('Id', sql.Int, pid),
      'SELECT Ativo, SenhaHash FROM dbo.Pacientes WHERE Id = @Id;',
      { requireContext: true }
    );

    if (!check.recordset?.[0]) throw httpError('Paciente não encontrado.', 404);
    if (!check.recordset[0].Ativo) return { sucesso: false, mensagem: 'Paciente já está desativado.' };

    if (!isAdmin(usuario)) {
      if (!senha) throw httpError('Senha é obrigatória para excluir a conta.', 400);

      const senhaHash = check.recordset[0].SenhaHash;
      if (!senhaHash) throw httpError('Paciente não encontrado.', 404);

      const ok = await bcrypt.compare(String(senha), String(senhaHash));
      if (!ok) throw httpError('Senha incorreta.', 401);
    }

    await queryWithContext(
      usuario,
      (req) => req.input('Id', sql.Int, pid),
      'UPDATE dbo.Pacientes SET Ativo = 0 WHERE Id = @Id;',
      { requireContext: true }
    );

    return { sucesso: true, mensagem: 'Paciente desativado com sucesso.', id: pid };
  },

  // Contato (Email/Telefone) - solicitar envio de código
  async solicitarVerificacaoContato(usuario, pacienteId, payload = {}) {
    const canal = normalizeCanalContato(payload?.canal ?? payload?.Canal);
    if (!canal) {
      throw httpError("Canal inválido. Use 'Email' ou 'Telefone'.", 400);
    }
    return solicitarVerificacaoContatoInterna({
      usuarioTipo: 'Paciente',
      usuarioId: pacienteId,
      canal,
      forcarReenvio: payload?.forcarReenvio ?? payload?.ForcarReenvio ?? true,
      destinoInformado: payload?.destino ?? payload?.Destino ?? null,
      expiraEmMinutos: 10,
      usuario,
      montarConteudo: ({ codigo, usuario: usuarioContato, expiraEmMinutos }) => montarEmailVerificacaoPaciente({
        nome: usuarioContato?.Nome,
        codigo,
        expiraEmMinutos,
      }),
    });
  },

  async confirmarVerificacaoContato(usuario, pacienteId, payload = {}) {
    const canal = normalizeCanalContato(payload?.canal ?? payload?.Canal);
    const codigo = String(payload?.codigo ?? payload?.Codigo ?? '').trim();

    if (!canal) {
      throw httpError("Canal inválido. Use 'Email' ou 'Telefone'.", 400);
    }
    if (!/^\d{6}$/.test(codigo)) {
      throw httpError("Código inválido. Envie um código numérico de 6 dígitos.", 400);
    }

    const result = await queryWithContext(
      usuario,
      (req) => {
        req.input('PacienteId', sql.Int, pacienteId);
        req.input('Canal', sql.NVarChar(40), canal);
      },
      `
        SELECT TOP 1
          Id,
          PacienteId,
          Canal,
          Destino,
          CodigoHash,
          CodigoSalt,
          ExpiraEm,
          Tentativas,
          MaxTentativas,
          Status
        FROM dbo.VerificacoesContato
        WHERE PacienteId = @PacienteId
          AND Canal = @Canal
        ORDER BY CriadoEm DESC;
      `,
      { requireContext: true }
    );

    const row = result?.recordset?.[0];
    if (!row) {
      throw httpError("Nenhuma verificação pendente encontrada para este canal.", 404);
    }

    if (String(row.Status).toLowerCase() === 'confirmado') {
      return { canal, status: 'Confirmado' };
    }

    const agora = new Date();

    if (agora > new Date(row.ExpiraEm)) {
      await queryWithContext(
        usuario,
        (req) => {
          req.input('Id', sql.Int, row.Id);
        },
        `
          UPDATE dbo.VerificacoesContato
          SET Status = N'Expirado'
          WHERE Id = @Id
            AND Status = N'Pendente';
        `,
        { requireContext: true }
      );
      throw httpError("Código expirado. Solicite um novo código.", 400);
    }

    if (String(row.Status).toLowerCase() === 'bloqueado') {
      throw httpError("Verificação bloqueada por excesso de tentativas. Solicite um novo código.", 400);
    }

    const destinoNormalizado = String(row.Destino);
    const salt = row.CodigoSalt; // Buffer
    const hashEsperado = row.CodigoHash; // Buffer

    const hashRecebido = calcularCodigoHash({ canal, destinoNormalizado, codigo, salt });

    const ok =
      Buffer.isBuffer(hashEsperado) &&
      Buffer.isBuffer(hashRecebido) &&
      hashEsperado.length === hashRecebido.length &&
      hashEsperado.equals(hashRecebido);

    if (!ok) {
      const tent = await queryWithContext(
        usuario,
        (req) => {
          req.input('Id', sql.Int, row.Id);
        },
        `
          DECLARE @Atualizado INT = 0;

          UPDATE dbo.VerificacoesContato
          SET Tentativas = ISNULL(Tentativas, 0) + 1,
              Status = CASE
                WHEN ISNULL(Tentativas, 0) + 1 >= ISNULL(MaxTentativas, 5) THEN N'Bloqueado'
                ELSE N'Pendente'
              END
          WHERE Id = @Id
            AND Status = N'Pendente';

          SET @Atualizado = @@ROWCOUNT;

          SELECT TOP 1
            @Atualizado AS Atualizado,
            Tentativas,
            MaxTentativas,
            Status,
            ExpiraEm
          FROM dbo.VerificacoesContato
          WHERE Id = @Id;
        `,
        { requireContext: true }
      );

      const tentRow = tent?.recordset?.[0];
      if (!tentRow) {
        throw httpError("Código incorreto.", 400);
      }

      if (!Number(tentRow.Atualizado ?? 0)) {
        const st = String(tentRow.Status || '').toLowerCase();
        if (st === 'confirmado') return { canal, status: 'Confirmado' };
        if (st === 'bloqueado') {
          throw httpError("Código incorreto. Verificação bloqueada por excesso de tentativas. Solicite um novo código.", 400);
        }
        if (tentRow.ExpiraEm && new Date() > new Date(tentRow.ExpiraEm)) {
          throw httpError("Código expirado. Solicite um novo código.", 400);
        }
        throw httpError("Código incorreto.", 400);
      }

      if (String(tentRow.Status).toLowerCase() === 'bloqueado') {
        throw httpError("Código incorreto. Verificação bloqueada por excesso de tentativas. Solicite um novo código.", 400);
      }
      throw httpError("Código incorreto.", 400);
    }

    const confirm = await queryWithContext(
      usuario,
      (req) => {
        req.input('Id', sql.Int, row.Id);
        req.input('PacienteId', sql.Int, pacienteId);
        req.input('Canal', sql.NVarChar(40), canal);
      },
      `
        SET XACT_ABORT ON;
        BEGIN TRAN;

        UPDATE dbo.VerificacoesContato
        SET Status = N'Confirmado',
            ConfirmadoEm = SYSDATETIME()
        WHERE Id = @Id
          AND Status = N'Pendente'
          AND ExpiraEm >= SYSDATETIME();

        IF @@ROWCOUNT = 1
        BEGIN
          IF @Canal = N'Email'
          BEGIN
            UPDATE dbo.Pacientes
            SET EmailVerificado = 1,
                EmailVerificadoEm = SYSDATETIME()
            WHERE Id = @PacienteId;
          END
          ELSE
          BEGIN
            UPDATE dbo.Pacientes
            SET TelefoneVerificado = 1,
                TelefoneVerificadoEm = SYSDATETIME()
            WHERE Id = @PacienteId;
          END
        END

        COMMIT;

        SELECT TOP 1
          Status,
          ExpiraEm
        FROM dbo.VerificacoesContato
        WHERE Id = @Id;
      `,
      { requireContext: true }
    );

    const statusFinal = String(confirm?.recordset?.[0]?.Status || '').toLowerCase();
    if (statusFinal === 'confirmado') {
      return { canal, status: 'Confirmado' };
    }
    if (statusFinal === 'bloqueado') {
      throw httpError("Verificação bloqueada por excesso de tentativas. Solicite um novo código.", 400);
    }
    if (confirm?.recordset?.[0]?.ExpiraEm && new Date() > new Date(confirm.recordset[0].ExpiraEm)) {
      throw httpError("Código expirado. Solicite um novo código.", 400);
    }
    throw httpError("Código inválido ou já processado. Solicite um novo código.", 400);
  
  },

};

export default pacientesService;
