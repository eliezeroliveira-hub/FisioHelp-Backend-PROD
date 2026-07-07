import bcrypt from 'bcrypt';
import crypto from 'crypto';
import contatoProvider from '../providers/contatoProvider.js';
import { sql } from '../config/dbConfig.js';
import { log } from '../config/logger.js';
import { queryWithContext } from './_queryWithContext.js';
import contatoFilaService from './contatoFilaService.js';
import { montarEmailRedefinicaoSenha } from './contatoTemplates.js';
import { HttpError } from '../utils/httpError.js';
import { getContatoSecret } from '../utils/contactSecret.js';
import { isValidEmail, normalizeEmail } from '../utils/identityValidators.js';
import { validatePasswordStrength } from '../utils/passwordPolicy.js';

const GENERIC_MESSAGE = 'Se o contato estiver cadastrado, ativo e verificado, enviaremos um código.';
const INVALID_CODE_MESSAGE = 'Código inválido ou expirado.';
const RESET_COOLDOWN_SECONDS = 60;
const RESET_EXPIRATION_MINUTES = 10;
const MAX_TENTATIVAS = 5;

function normalizeRequestEmail(value) {
  const email = normalizeEmail(value);
  if (!email || !isValidEmail(email)) {
    throw new HttpError(400, 'E-mail inválido.');
  }
  return email;
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizarTelefoneReset(value) {
  const digits = onlyDigits(value);
  if (!digits) {
    throw new HttpError(400, 'Telefone inválido.');
  }

  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    return {
      e164: `+${digits}`,
      digits,
      localDigits: digits.slice(2),
    };
  }

  if (digits.length === 10 || digits.length === 11) {
    return {
      e164: `+55${digits}`,
      digits: `55${digits}`,
      localDigits: digits,
    };
  }

  throw new HttpError(400, 'Telefone inválido.');
}

function normalizarCanalRedefinicao(value, fallback = 'Email') {
  const raw = String(value || fallback).trim().toLowerCase();
  if (raw === 'email' || raw === 'e-mail') return 'Email';
  if (raw === 'telefone' || raw === 'tel' || raw === 'whatsapp' || raw === 'whats') return 'Telefone';
  throw new HttpError(400, 'Canal inválido.');
}

function normalizarPedidoRedefinicao(payload = {}) {
  const dados = payload || {};
  const canal = normalizarCanalRedefinicao(
    dados.canal,
    dados.telefone ? 'Telefone' : 'Email'
  );

  if (canal === 'Telefone') {
    const telefone = normalizarTelefoneReset(dados.destino ?? dados.telefone);
    return {
      canal,
      destino: telefone.e164,
      telefone,
    };
  }

  const email = normalizeRequestEmail(dados.destino ?? dados.email);
  return {
    canal,
    destino: email,
    email,
  };
}

function mensagemResetWhatsApp(codigo) {
  return [
    `Seu codigo para redefinir a senha da FisioHelp e: ${codigo}`,
    '',
    `Nao compartilhe este codigo. Ele expira em ${RESET_EXPIRATION_MINUTES} minutos.`,
  ].join('\n');
}

function clientIp(reqLike) {
  const ip = String(reqLike?.ip || reqLike?.socket?.remoteAddress || '').trim();
  return ip.slice(0, 64) || null;
}

function userAgent(reqLike) {
  const ua = String(reqLike?.headers?.['user-agent'] || '').trim();
  return ua.slice(0, 400) || null;
}

function gerarCodigo6() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function gerarSalt16() {
  return crypto.randomBytes(16);
}

function calcularCodigoHash({ salt, usuarioTipo, usuarioId, email, codigo }) {
  const saltHex = Buffer.isBuffer(salt) ? salt.toString('hex') : String(salt || '');
  const base = `${saltHex}:ResetSenha:${String(usuarioTipo)}:${Number(usuarioId)}:${String(email)}:${String(codigo)}`;
  return crypto.createHmac('sha256', getContatoSecret()).update(base, 'utf8').digest();
}

function mascararEmail(email) {
  return contatoProvider?.mascararDestino
    ? contatoProvider.mascararDestino('Email', email)
    : String(email || '').replace(/^(.{2}).*(@.*)$/u, '$1***$2');
}

function isUniqueViolation(err) {
  const number =
    err?.number ??
    err?.originalError?.info?.number ??
    err?.originalError?.number ??
    null;
  return number === 2601 || number === 2627;
}

async function buscarUsuarioPorEmail(email) {
  const result = await queryWithContext(
    null,
    (req) => req.input('Email', sql.NVarChar(300), email),
    `
      SELECT TOP 1
        Id,
        Nome,
        Email,
        Telefone,
        EmailVerificado,
        TelefoneVerificado,
        Ativo,
        IsBloqueado,
        N'Paciente' AS UsuarioTipo
      FROM dbo.Pacientes
      WHERE LOWER(LTRIM(RTRIM(Email))) = @Email

      UNION ALL

      SELECT TOP 1
        Id,
        Nome,
        Email,
        Telefone,
        EmailVerificado,
        TelefoneVerificado,
        Ativo,
        IsBloqueado,
        N'Fisioterapeuta' AS UsuarioTipo
      FROM dbo.Fisioterapeutas
      WHERE LOWER(LTRIM(RTRIM(Email))) = @Email;
    `
  );

  const rows = result.recordset || [];
  if (rows.length > 1) {
    log('warn', 'E-mail ambíguo em redefinição de senha', {
      emailMascarado: mascararEmail(email),
      total: rows.length,
    });
    return { usuario: null, motivo: 'ambiguous' };
  }

  return { usuario: rows[0] || null, motivo: rows.length ? null : 'not_found' };
}

async function buscarUsuarioPorTelefone({ digits, localDigits }) {
  const result = await queryWithContext(
    null,
    (req) => req
      .input('TelefoneDigits', sql.NVarChar(30), digits)
      .input('TelefoneLocalDigits', sql.NVarChar(30), localDigits),
    `
      SELECT TOP 1
        Id,
        Nome,
        Email,
        Telefone,
        EmailVerificado,
        TelefoneVerificado,
        Ativo,
        IsBloqueado,
        N'Paciente' AS UsuarioTipo
      FROM dbo.Pacientes
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(Telefone, N''), N'+', N''), N' ', N''), N'-', N''), N'(', N''), N')', N'')
            IN (@TelefoneDigits, @TelefoneLocalDigits)

      UNION ALL

      SELECT TOP 1
        Id,
        Nome,
        Email,
        Telefone,
        EmailVerificado,
        TelefoneVerificado,
        Ativo,
        IsBloqueado,
        N'Fisioterapeuta' AS UsuarioTipo
      FROM dbo.Fisioterapeutas
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(Telefone, N''), N'+', N''), N' ', N''), N'-', N''), N'(', N''), N')', N'')
            IN (@TelefoneDigits, @TelefoneLocalDigits);
    `
  );

  const rows = result.recordset || [];
  if (rows.length > 1) {
    log('warn', 'Telefone ambíguo em redefinição de senha', {
      telefoneMascarado: contatoProvider.mascararDestino('Telefone', `+${digits}`),
      total: rows.length,
    });
    return { usuario: null, motivo: 'ambiguous' };
  }

  return { usuario: rows[0] || null, motivo: rows.length ? null : 'not_found' };
}

async function resolverUsuarioRedefinicao(pedido) {
  if (pedido.canal === 'Telefone') {
    const { usuario, motivo } = await buscarUsuarioPorTelefone(pedido.telefone);
    const emailChave = usuario?.Email ? normalizeEmail(usuario.Email) : '';
    return {
      canal: pedido.canal,
      destino: pedido.destino,
      usuario,
      motivo: emailChave ? motivo : (usuario ? 'missing_email' : motivo),
      emailChave,
    };
  }

  const { usuario, motivo } = await buscarUsuarioPorEmail(pedido.email);
  return {
    canal: pedido.canal,
    destino: pedido.destino,
    usuario,
    motivo,
    emailChave: pedido.email,
  };
}

function usuarioAptoParaReset(usuario) {
  if (!usuario) return false;
  if (Number(usuario.Ativo ?? 0) !== 1) return false;
  if (Number(usuario.IsBloqueado ?? 0) === 1) return false;
  return true;
}

function contatoVerificadoParaReset(usuario, canal) {
  if (!usuario) return false;
  if (canal === 'Telefone') {
    return Number(usuario.TelefoneVerificado ?? 0) === 1;
  }
  return Number(usuario.EmailVerificado ?? 0) === 1;
}

function invalidCodeError() {
  return new HttpError(400, INVALID_CODE_MESSAGE);
}

async function obterRedefinicaoPendente({ usuarioTipo, usuarioId, email }) {
  const result = await queryWithContext(
    null,
    (req) => req
      .input('UsuarioTipo', sql.NVarChar(30), usuarioTipo)
      .input('UsuarioId', sql.Int, usuarioId)
      .input('Email', sql.NVarChar(255), email),
    `
      SELECT TOP 1
        Id,
        UsuarioTipo,
        UsuarioId,
        Email,
        CodigoHash,
        CodigoSalt,
        ExpiraEm,
        Tentativas,
        MaxTentativas,
        Status
      FROM dbo.RedefinicoesSenha
      WHERE UsuarioTipo = @UsuarioTipo
        AND UsuarioId = @UsuarioId
        AND Email = @Email
        AND Status = N'Pendente'
      ORDER BY Id DESC;
    `
  );

  return result.recordset?.[0] || null;
}

async function validarCodigoPendente({ usuario, email, codigo }) {
  const codigoRaw = String(codigo || '').replace(/\D/g, '');
  if (codigoRaw.length !== 6) throw invalidCodeError();

  const row = await obterRedefinicaoPendente({
    usuarioTipo: usuario.UsuarioTipo,
    usuarioId: usuario.Id,
    email,
  });

  if (!row) throw invalidCodeError();

  const expiraEm = row.ExpiraEm ? new Date(row.ExpiraEm) : null;
  if (!expiraEm || Number.isNaN(expiraEm.getTime()) || expiraEm.getTime() <= Date.now()) {
    throw invalidCodeError();
  }

  if (Number(row.Tentativas ?? 0) >= Number(row.MaxTentativas ?? MAX_TENTATIVAS)) {
    throw invalidCodeError();
  }

  const expected = calcularCodigoHash({
    salt: row.CodigoSalt,
    usuarioTipo: usuario.UsuarioTipo,
    usuarioId: usuario.Id,
    email,
    codigo: codigoRaw,
  });

  if (!crypto.timingSafeEqual(Buffer.from(row.CodigoHash), expected)) {
    throw invalidCodeError();
  }

  return row;
}


export async function solicitarRedefinicaoSenha(payload = {}, reqLike = null) {
  const pedido = normalizarPedidoRedefinicao(payload);
  const { canal, destino, usuario, emailChave } = await resolverUsuarioRedefinicao(pedido);

  if (!usuarioAptoParaReset(usuario) || !emailChave || !contatoVerificadoParaReset(usuario, canal)) {
    return { sucesso: true, mensagem: GENERIC_MESSAGE };
  }

  const codigo = gerarCodigo6();
  const salt = gerarSalt16();
  const codigoHash = calcularCodigoHash({
    salt,
    usuarioTipo: usuario.UsuarioTipo,
    usuarioId: usuario.Id,
    email: emailChave,
    codigo,
  });
  const expiraEm = new Date(Date.now() + RESET_EXPIRATION_MINUTES * 60 * 1000);

  let resetId = null;
  try {
    const result = await queryWithContext(
      null,
      (req) => req
        .input('UsuarioTipo', sql.NVarChar(30), usuario.UsuarioTipo)
        .input('UsuarioId', sql.Int, Number(usuario.Id))
        .input('Email', sql.NVarChar(255), emailChave)
        .input('CodigoHash', sql.VarBinary(32), codigoHash)
        .input('CodigoSalt', sql.VarBinary(16), salt)
        .input('ExpiraEm', sql.DateTime2(7), expiraEm)
        .input('MaxTentativas', sql.SmallInt, MAX_TENTATIVAS)
        .input('CooldownSegundos', sql.Int, RESET_COOLDOWN_SECONDS)
        .input('IpSolicitacao', sql.NVarChar(64), clientIp(reqLike))
        .input('UserAgent', sql.NVarChar(400), userAgent(reqLike)),
      `
        SET NOCOUNT ON;
        SET XACT_ABORT ON;

        BEGIN TRAN;

        DECLARE @AtualId INT = NULL;
        DECLARE @UltimoEnvioEm DATETIME2(7) = NULL;

        SELECT TOP 1
          @AtualId = Id,
          @UltimoEnvioEm = UltimoEnvioEm
        FROM dbo.RedefinicoesSenha WITH (UPDLOCK, HOLDLOCK)
        WHERE UsuarioTipo = @UsuarioTipo
          AND UsuarioId = @UsuarioId
          AND Status = N'Pendente'
        ORDER BY Id DESC;

        IF (@UltimoEnvioEm IS NOT NULL AND DATEDIFF(SECOND, @UltimoEnvioEm, SYSDATETIME()) < @CooldownSegundos)
        BEGIN
          SELECT
            @AtualId AS Id,
            CAST(0 AS BIT) AS DeveEnviar;
          COMMIT;
          RETURN;
        END

        IF @AtualId IS NULL
        BEGIN
          INSERT INTO dbo.RedefinicoesSenha
            (UsuarioTipo, UsuarioId, Email, CodigoHash, CodigoSalt, ExpiraEm, Tentativas, MaxTentativas, Status, CriadoEm, AtualizadoEm, UltimoEnvioEm, IpSolicitacao, UserAgent)
          VALUES
            (@UsuarioTipo, @UsuarioId, @Email, @CodigoHash, @CodigoSalt, @ExpiraEm, 0, @MaxTentativas, N'Pendente', SYSDATETIME(), SYSDATETIME(), SYSDATETIME(), @IpSolicitacao, @UserAgent);

          SELECT CAST(SCOPE_IDENTITY() AS INT) AS Id, CAST(1 AS BIT) AS DeveEnviar;
        END
        ELSE
        BEGIN
          UPDATE dbo.RedefinicoesSenha
          SET Email = @Email,
              CodigoHash = @CodigoHash,
              CodigoSalt = @CodigoSalt,
              ExpiraEm = @ExpiraEm,
              Tentativas = 0,
              MaxTentativas = @MaxTentativas,
              Status = N'Pendente',
              AtualizadoEm = SYSDATETIME(),
              UltimoEnvioEm = SYSDATETIME(),
              IpSolicitacao = @IpSolicitacao,
              UserAgent = @UserAgent
          WHERE Id = @AtualId;

          SELECT @AtualId AS Id, CAST(1 AS BIT) AS DeveEnviar;
        END

        COMMIT;
      `
    );

    const row = result.recordset?.[0] || null;
    resetId = row?.Id || null;

    if (Number(row?.DeveEnviar ?? 0) !== 1) {
      return { sucesso: true, mensagem: GENERIC_MESSAGE };
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      log('warn', 'Colisão de reset de senha pendente', {
        emailMascarado: mascararEmail(emailChave),
        usuarioTipo: usuario.UsuarioTipo,
        usuarioId: usuario.Id,
      });
      return { sucesso: true, mensagem: GENERIC_MESSAGE };
    }
    throw err;
  }

  if (canal === 'Telefone') {
    await contatoFilaService.enfileirarCodigo({
      tipo: 'RedefinicaoSenha',
      canal: 'Telefone',
      destino,
      texto: mensagemResetWhatsApp(codigo),
      payload: {
        resetId,
        usuarioTipo: usuario.UsuarioTipo,
        usuarioId: usuario.Id,
        origem: 'auth.senha.esqueci',
      },
    });
  } else {
    const conteudo = montarEmailRedefinicaoSenha({
      nome: usuario.Nome,
      codigo,
      expiraEmMinutos: RESET_EXPIRATION_MINUTES,
    });

    await contatoFilaService.enfileirarCodigo({
      tipo: 'RedefinicaoSenha',
      canal: 'Email',
      destino,
      assunto: conteudo.assunto,
      html: conteudo.corpoHtml,
      texto: conteudo.corpoTexto,
      payload: {
        resetId,
        usuarioTipo: usuario.UsuarioTipo,
        usuarioId: usuario.Id,
        origem: 'auth.senha.esqueci',
      },
    });
  }

  return { sucesso: true, mensagem: GENERIC_MESSAGE };
}

export async function confirmarCodigoRedefinicaoSenha(payload = {}) {
  const dados = payload || {};
  const pedido = normalizarPedidoRedefinicao(dados);
  const { canal, usuario, emailChave } = await resolverUsuarioRedefinicao(pedido);
  if (!usuarioAptoParaReset(usuario) || !emailChave || !contatoVerificadoParaReset(usuario, canal)) throw invalidCodeError();

  await validarCodigoPendente({ usuario, email: emailChave, codigo: dados.codigo });
  return { sucesso: true, mensagem: 'Código validado.' };
}

export async function redefinirSenha(payload = {}) {
  const dados = payload || {};
  const pedido = normalizarPedidoRedefinicao(dados);
  const { canal, usuario, emailChave } = await resolverUsuarioRedefinicao(pedido);
  const senhaNova = String(dados.novaSenha || '');
  validatePasswordStrength(senhaNova);

  if (!usuarioAptoParaReset(usuario) || !emailChave || !contatoVerificadoParaReset(usuario, canal)) throw invalidCodeError();

  const codigoRaw = String(dados.codigo || '').replace(/\D/g, '');
  if (codigoRaw.length !== 6) throw invalidCodeError();

  const senhaHash = await bcrypt.hash(senhaNova, 12);

  const result = await queryWithContext(
    null,
    (req) => req
      .input('UsuarioTipo', sql.NVarChar(30), usuario.UsuarioTipo)
      .input('UsuarioId', sql.Int, Number(usuario.Id))
      .input('Email', sql.NVarChar(255), emailChave)
      .input('Codigo', sql.NVarChar(6), codigoRaw)
      .input('SenhaHash', sql.NVarChar(256), senhaHash),
    `
      SET NOCOUNT ON;

      DECLARE @ResetId INT = NULL;
      DECLARE @CodigoHash VARBINARY(32) = NULL;
      DECLARE @CodigoSalt VARBINARY(16) = NULL;
      DECLARE @Tentativas SMALLINT = NULL;
      DECLARE @MaxTentativas SMALLINT = NULL;
      DECLARE @ExpiraEm DATETIME2(7) = NULL;

      SELECT TOP 1
        @ResetId = Id,
        @CodigoHash = CodigoHash,
        @CodigoSalt = CodigoSalt,
        @Tentativas = Tentativas,
        @MaxTentativas = MaxTentativas,
        @ExpiraEm = ExpiraEm
      FROM dbo.RedefinicoesSenha WITH (UPDLOCK, HOLDLOCK)
      WHERE UsuarioTipo = @UsuarioTipo
        AND UsuarioId = @UsuarioId
        AND Email = @Email
        AND Status = N'Pendente'
      ORDER BY Id DESC;

      SELECT
        @ResetId AS ResetId,
        @CodigoHash AS CodigoHash,
        @CodigoSalt AS CodigoSalt,
        @Tentativas AS Tentativas,
        @MaxTentativas AS MaxTentativas,
        @ExpiraEm AS ExpiraEm;
    `
  );

  const row = result.recordset?.[0] || null;
  if (!row?.ResetId) throw invalidCodeError();

  const expiraEm = row.ExpiraEm ? new Date(row.ExpiraEm) : null;
  if (!expiraEm || Number.isNaN(expiraEm.getTime()) || expiraEm.getTime() <= Date.now()) {
    await queryWithContext(
      null,
      (req) => req.input('ResetId', sql.Int, row.ResetId),
      `
        UPDATE dbo.RedefinicoesSenha
        SET Status = N'Expirado',
            AtualizadoEm = SYSDATETIME()
        WHERE Id = @ResetId
          AND Status = N'Pendente';
      `
    );
    throw invalidCodeError();
  }

  if (Number(row.Tentativas ?? 0) >= Number(row.MaxTentativas ?? MAX_TENTATIVAS)) {
    throw invalidCodeError();
  }

  const expected = calcularCodigoHash({
    salt: row.CodigoSalt,
    usuarioTipo: usuario.UsuarioTipo,
    usuarioId: usuario.Id,
    email: emailChave,
    codigo: codigoRaw,
  });

  if (!crypto.timingSafeEqual(Buffer.from(row.CodigoHash), expected)) {
    await queryWithContext(
      null,
      (req) => req.input('ResetId', sql.Int, row.ResetId),
      `
        UPDATE dbo.RedefinicoesSenha
        SET Tentativas = CASE WHEN Tentativas < MaxTentativas THEN Tentativas + 1 ELSE Tentativas END,
            Status = CASE WHEN Tentativas + 1 >= MaxTentativas THEN N'Bloqueado' ELSE Status END,
            AtualizadoEm = SYSDATETIME()
        WHERE Id = @ResetId
          AND Status = N'Pendente';
      `
    );
    throw invalidCodeError();
  }

  const tabela = usuario.UsuarioTipo === 'Paciente' ? 'dbo.Pacientes' : 'dbo.Fisioterapeutas';
  await queryWithContext(
    null,
    (req) => req
      .input('UsuarioTipo', sql.NVarChar(30), usuario.UsuarioTipo)
      .input('UsuarioId', sql.Int, Number(usuario.Id))
      .input('SenhaHash', sql.NVarChar(256), senhaHash)
      .input('ResetId', sql.Int, row.ResetId)
      .input('Canal', sql.NVarChar(20), canal),
    `
      SET XACT_ABORT ON;
      BEGIN TRAN;

      UPDATE dbo.RedefinicoesSenha
      SET Status = N'Confirmado',
          ConfirmadoEm = SYSDATETIME(),
          AtualizadoEm = SYSDATETIME()
      WHERE Id = @ResetId
        AND Status = N'Pendente';

      IF @@ROWCOUNT = 0
      BEGIN
        ROLLBACK;
        THROW 50001, N'Código inválido ou expirado.', 1;
      END

      UPDATE ${tabela}
      SET SenhaHash = @SenhaHash,
          EmailVerificado = CASE WHEN @Canal = N'Email' THEN 1 ELSE EmailVerificado END,
          EmailVerificadoEm = CASE
            WHEN @Canal = N'Email' THEN COALESCE(EmailVerificadoEm, SYSDATETIME())
            ELSE EmailVerificadoEm
          END,
          TelefoneVerificado = CASE WHEN @Canal = N'Telefone' THEN 1 ELSE TelefoneVerificado END,
          TelefoneVerificadoEm = CASE
            WHEN @Canal = N'Telefone' THEN COALESCE(TelefoneVerificadoEm, SYSDATETIME())
            ELSE TelefoneVerificadoEm
          END
      WHERE Id = @UsuarioId;

      UPDATE dbo.RefreshTokens
      SET RevogadoEm = SYSDATETIME(),
          RevogadoMotivo = N'ResetSenha'
      WHERE UsuarioTipo = @UsuarioTipo
        AND UsuarioId = @UsuarioId
        AND RevogadoEm IS NULL;

      COMMIT;
    `
  );

  return { sucesso: true, mensagem: 'Senha redefinida com sucesso.' };
}

export default {
  solicitarRedefinicaoSenha,
  confirmarCodigoRedefinicaoSenha,
  redefinirSenha,
};
