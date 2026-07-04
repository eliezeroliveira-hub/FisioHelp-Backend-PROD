// services/authService.js
import getPool, { sql } from "../config/dbConfig.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import net from "net";
import { ENV } from "../config/env.js";
import { log } from "../config/logger.js";
import { normalizeCNPJ, normalizeEmail } from "../utils/identityValidators.js";

const REFRESH_DAYS = Number(ENV.REFRESH_TOKEN_DAYS || 30);
const ACCESS_TOKEN_CACHE_FALLBACK_TTL_MS = 30 * 1000;
const accessTokenRevocationCache = new Map();

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function toExpMs(expSeconds) {
  const n = Number(expSeconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n * 1000);
}

function getCacheEntry(jti) {
  const key = String(jti || "").trim();
  if (!key) return null;

  const entry = accessTokenRevocationCache.get(key);
  if (!entry) return null;

  if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now()) {
    accessTokenRevocationCache.delete(key);
    return null;
  }

  return entry;
}

function setCacheEntry(jti, revoked, expSeconds, fallbackTtlMs = ACCESS_TOKEN_CACHE_FALLBACK_TTL_MS) {
  const key = String(jti || "").trim();
  if (!key) return;

  const expMs = toExpMs(expSeconds);
  const expiresAt = expMs && expMs > Date.now() ? expMs : (Date.now() + fallbackTtlMs);
  if (expiresAt <= Date.now()) {
    accessTokenRevocationCache.delete(key);
    return;
  }

  accessTokenRevocationCache.set(key, {
    revoked: revoked === true,
    expiresAt
  });
}

const LOGIN_LOCK_MAX_FALHAS = parsePositiveInt(process.env.LOGIN_LOCK_MAX_FALHAS, 5);
const LOGIN_LOCK_MINUTOS = parsePositiveInt(process.env.LOGIN_LOCK_MINUTOS, 15);
const TOKEN_EXP_REGEX = /^\d+[smhd]$/;

if (!ENV.TOKEN_EXPIRATION || !TOKEN_EXP_REGEX.test(ENV.TOKEN_EXPIRATION)) {
  throw new Error(
    'TOKEN_EXPIRATION inválido ou ausente. Use formato como "15m", "1h", "7d", "30s".'
  );
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function newOpaqueToken() {
  // refresh token (opaco) — armazenamos apenas o hash (sha256) no banco
  return crypto.randomBytes(64).toString("base64url");
}

function normalizeDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function normalizeIp(value) {
  if (value === null || value === undefined) return null;
  let ip = String(value).trim();
  if (!ip) return null;

  // Compat com IPv4 mapeado em IPv6: ::ffff:127.0.0.1
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);

  return net.isIP(ip) ? ip : null;
}

function isPrivateIp(ip) {
  const version = net.isIP(ip);
  if (!version) return true;

  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  const low = ip.toLowerCase();
  if (low === "::1" || low === "::") return true;
  if (low.startsWith("fc") || low.startsWith("fd")) return true; // ULA
  if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true; // link-local
  return false;
}

function getClientIp(reqLike) {
  const ipFromExpress = normalizeIp(reqLike?.ip);
  const remoteIp = normalizeIp(reqLike?.socket?.remoteAddress || reqLike?.connection?.remoteAddress);

  const xf = reqLike?.headers?.["x-forwarded-for"];
  const xfFirst = typeof xf === "string" && xf.length
    ? normalizeIp(xf.split(",")[0].trim())
    : null;

  // Prioriza o que o Express já resolveu com trust proxy.
  if (ipFromExpress) return ipFromExpress;

  // Só considera XFF quando há indício de proxy local/privado.
  if (xfFirst && remoteIp && isPrivateIp(remoteIp)) return xfFirst;

  return remoteIp || xfFirst || null;
}

function getUserAgent(reqLike) {
  const ua = reqLike?.headers?.["user-agent"];
  return String(ua || "").slice(0, 400) || null;
}

function buildAccessTokenPayload(usuario, jti) {
  return {
    userId: Number(usuario.id),
    tipoUsuario: usuario.tipo,
    nome: usuario.nome || null,
    jti
  };
}

function to01(x, def = 0) {
  if (x === 1 || x === true) return 1;
  if (x === 0 || x === false) return 0;
  if (x === null || x === undefined) return def;

  if (typeof x === "string") {
    const s = x.trim().toLowerCase();
    if (s === "1" || s === "true" || s === "sim" || s === "yes") return 1;
    if (s === "0" || s === "false" || s === "nao" || s === "não" || s === "no") return 0;

    const n = Number(s);
    if (Number.isFinite(n)) return n > 0 ? 1 : 0;
    return def;
  }

  if (typeof x === "number") {
    if (!Number.isFinite(x)) return def;
    return x > 0 ? 1 : 0;
  }

  try {
    const n = Number(x);
    if (Number.isFinite(n)) return n > 0 ? 1 : 0;
  } catch (_) {
    // ignore
  }
  return def;
}

function normalizeTipoUsuario(tipo) {
  const t = String(tipo ?? "").trim().toLowerCase();
  if (!t) return null;
  if (t === "admin" || t === "administrador" || t === "administradores") return "Admin";
  if (t === "paciente") return "Paciente";
  if (t === "fisioterapeuta" || t === "fisio") return "Fisioterapeuta";
  return String(tipo).trim();
}

function normalizeOAuthProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (provider === "apple" || provider === "google") return provider;
  return null;
}

function normalizeOAuthSubject(value) {
  const subject = String(value ?? "").trim();
  return subject ? subject.slice(0, 255) : null;
}

function isApplePrivateRelayEmail(email) {
  return /@privaterelay\.appleid\.com$/i.test(String(email || "").trim());
}
function formatarDataHoraPtBr(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;

  // Formatação determinística para Brasília (UTC-3), sem depender de ICU/timezone do host.
  const br = new Date(d.getTime() - (3 * 60 * 60 * 1000));
  const dd = String(br.getUTCDate()).padStart(2, "0");
  const mm = String(br.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = br.getUTCFullYear();
  const hh = String(br.getUTCHours()).padStart(2, "0");
  const mi = String(br.getUTCMinutes()).padStart(2, "0");
  const ss = String(br.getUTCSeconds()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy}, ${hh}:${mi}:${ss}`;
}

function mensagemMuitasTentativas(bloqueadoAte) {
  const quando = formatarDataHoraPtBr(bloqueadoAte);
  if (!quando) return "Muitas tentativas. Aguarde 15 minutos.";
  return `Muitas tentativas. Tente novamente após ${quando}.`;
}

function mensagemMuitasTentativasPorSegundos(segundosRestantes) {
  const s = Number(segundosRestantes);
  if (!Number.isFinite(s) || s <= 0) return "Muitas tentativas. Aguarde 15 minutos.";
  const quando = new Date(Date.now() + (s * 1000));
  return mensagemMuitasTentativas(quando);
}

function lockoutKey(usuario) {
  return {
    usuarioTipo: normalizeTipoUsuario(usuario?.tipo),
    usuarioId: Number(usuario?.id)
  };
}

async function assertContaNaoBloqueada(pool, usuario) {
  const { usuarioTipo, usuarioId } = lockoutKey(usuario);
  if (!usuarioTipo || !usuarioId) return;

  const r = await pool
    .request()
    .input("UsuarioTipo", sql.NVarChar(30), usuarioTipo)
    .input("UsuarioId", sql.Int, usuarioId)
    .query(`
      IF OBJECT_ID('dbo.LoginLockouts', 'U') IS NULL
        THROW 50090, 'Infraestrutura de autenticação indisponível.', 1;

      DELETE FROM dbo.LoginLockouts
      WHERE UsuarioTipo = @UsuarioTipo
        AND UsuarioId = @UsuarioId
        AND BloqueadoAte IS NOT NULL
        AND BloqueadoAte <= SYSDATETIME();

      SELECT
        MAX(BloqueadoAte) AS BloqueadoAte,
        CAST(
          CASE
            WHEN MAX(CASE WHEN BloqueadoAte > SYSDATETIME() THEN 1 ELSE 0 END) = 1
            THEN 1 ELSE 0
          END
        AS INT) AS BloqueadoAgora,
        CASE
          WHEN MAX(BloqueadoAte) > SYSDATETIME()
          THEN DATEDIFF(SECOND, SYSDATETIME(), MAX(BloqueadoAte))
          ELSE 0
        END AS SegundosRestantes
      FROM dbo.LoginLockouts
      WHERE UsuarioTipo = @UsuarioTipo
        AND UsuarioId = @UsuarioId;
    `);

  const bloqueadoAgora = Number(r.recordset?.[0]?.BloqueadoAgora ?? 0) === 1;
  const segundosRestantes = Number(r.recordset?.[0]?.SegundosRestantes ?? 0);
  const bloqueadoAte = r.recordset?.[0]?.BloqueadoAte;
  if (bloqueadoAgora) {
    throw new Error(
      segundosRestantes > 0
        ? mensagemMuitasTentativasPorSegundos(segundosRestantes)
        : mensagemMuitasTentativas(bloqueadoAte)
    );
  }
}

async function registrarFalhaLoginConta(pool, usuario) {
  const { usuarioTipo, usuarioId } = lockoutKey(usuario);
  if (!usuarioTipo || !usuarioId) return null;

  const r = await pool
    .request()
    .input("UsuarioTipo", sql.NVarChar(30), usuarioTipo)
    .input("UsuarioId", sql.Int, usuarioId)
    .input("MaxFalhas", sql.Int, LOGIN_LOCK_MAX_FALHAS)
    .input("FalhasParaBloqueio", sql.Int, LOGIN_LOCK_MAX_FALHAS + 1)
    .input("Minutos", sql.Int, LOGIN_LOCK_MINUTOS)
    .query(`
      IF OBJECT_ID('dbo.LoginLockouts', 'U') IS NULL
        THROW 50090, 'Infraestrutura de autenticação indisponível.', 1;

      BEGIN TRY
        BEGIN TRAN;

        IF EXISTS (
          SELECT 1
          FROM dbo.LoginLockouts WITH (UPDLOCK, HOLDLOCK)
          WHERE UsuarioTipo = @UsuarioTipo
            AND UsuarioId = @UsuarioId
        )
        BEGIN
          UPDATE dbo.LoginLockouts
          SET FalhasConsecutivas = ISNULL(FalhasConsecutivas, 0) + 1,
              UltimaFalhaEm = SYSDATETIME(),
              AtualizadoEm = SYSDATETIME()
          WHERE UsuarioTipo = @UsuarioTipo
            AND UsuarioId = @UsuarioId;
        END
        ELSE
        BEGIN
          INSERT INTO dbo.LoginLockouts
            (UsuarioTipo, UsuarioId, FalhasConsecutivas, BloqueadoAte, UltimaFalhaEm, UltimoSucessoEm, CriadoEm, AtualizadoEm)
          VALUES
            (@UsuarioTipo, @UsuarioId, 1, NULL, SYSDATETIME(), NULL, SYSDATETIME(), SYSDATETIME());
        END

        UPDATE dbo.LoginLockouts
        SET BloqueadoAte = CASE
              WHEN ISNULL(FalhasConsecutivas, 0) >= @FalhasParaBloqueio
                   AND (BloqueadoAte IS NULL OR BloqueadoAte <= SYSDATETIME())
              THEN DATEADD(MINUTE, @Minutos, SYSDATETIME())
              ELSE BloqueadoAte
            END,
            AtualizadoEm = SYSDATETIME()
        WHERE UsuarioTipo = @UsuarioTipo
          AND UsuarioId = @UsuarioId;

        SELECT TOP 1
          FalhasConsecutivas,
          BloqueadoAte,
          CAST(CASE WHEN BloqueadoAte IS NOT NULL AND BloqueadoAte > SYSDATETIME() THEN 1 ELSE 0 END AS INT) AS BloqueadoAgora,
          CASE
            WHEN BloqueadoAte IS NOT NULL AND BloqueadoAte > SYSDATETIME()
            THEN DATEDIFF(SECOND, SYSDATETIME(), BloqueadoAte)
            ELSE 0
          END AS SegundosRestantes
        FROM dbo.LoginLockouts
        WHERE UsuarioTipo = @UsuarioTipo
          AND UsuarioId = @UsuarioId;

        COMMIT;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH
    `);

  return r.recordset?.[0] || null;
}

async function registrarSucessoLoginConta(pool, usuario) {
  const { usuarioTipo, usuarioId } = lockoutKey(usuario);
  if (!usuarioTipo || !usuarioId) return;

  await pool
    .request()
    .input("UsuarioTipo", sql.NVarChar(30), usuarioTipo)
    .input("UsuarioId", sql.Int, usuarioId)
    .query(`
      IF OBJECT_ID('dbo.LoginLockouts', 'U') IS NULL
        THROW 50090, 'Infraestrutura de autenticação indisponível.', 1;

      DELETE FROM dbo.LoginLockouts
      WHERE UsuarioTipo = @UsuarioTipo
        AND UsuarioId = @UsuarioId;
    `);
}

/**
 * Fonte de verdade para (Ativo/IsBloqueado) pelo Id
 * (usado para revalidar login/refresh)
 */
async function reloadAuthFlagsByTipoId(pool, tipo, id) {
  const t = normalizeTipoUsuario(tipo);
  const userId = Number(id);
  if (!pool || !t || !userId) return null;

  let q = null;

  if (t === "Admin") {
    q = `
      SELECT CAST(Ativo AS INT) AS Ativo,
             NivelAcesso
      FROM dbo.Administradores
      WHERE Id = @Id;
    `;
  } else if (t === "Paciente") {
    q = `
      SELECT CAST(Ativo AS INT) AS Ativo,
             CAST(ISNULL(IsBloqueado, 0) AS INT) AS IsBloqueado
      FROM dbo.Pacientes
      WHERE Id = @Id;
    `;
  } else if (t === "Fisioterapeuta") {
    q = `
      SELECT CAST(Ativo AS INT) AS Ativo,
             CAST(ISNULL(IsBloqueado, 0) AS INT) AS IsBloqueado
      FROM dbo.Fisioterapeutas
      WHERE Id = @Id;
    `;
  } else {
    return null;
  }

  const r = await pool.request().input("Id", sql.Int, userId).query(q);
  const row = r.recordset?.[0];
  if (!row) return null;

  return {
    ativo: to01(row.Ativo, 0),
    isBloqueado: to01(row.IsBloqueado, 0),
    nivelAcesso: row.NivelAcesso ?? null
  };
}

function enforceAcessoLogin(usuario) {
  const tipo = normalizeTipoUsuario(usuario?.tipo);

  // Ativo é obrigatório para todos
  const ativo01 = to01(usuario?.ativo, 0);
  if (ativo01 === 0) {
    if (tipo === "Fisioterapeuta") throw new Error("Conta desativada pelo administrador.");
    throw new Error("Conta desativada pelo administrador.");
  }

  // Admin não tem IsBloqueado (apenas Ativo)
  if (tipo === "Admin") return;

  const bloqueado01 = to01(usuario?.isBloqueado, 0);
  if (bloqueado01 === 1) {
    if (tipo === "Fisioterapeuta") throw new Error("Conta bloqueada pelo administrador.");
    throw new Error("Conta bloqueada pelo administrador.");
  }
}

/**
 * Busca usuário para login:
 * - Por EMAIL: usa SP unificada dbo.sp_LoginPorEmail_Min
 *
 * - Por CPF (Paciente): usa a SP mínima dbo.sp_LoginPacientePorCpf_Min
 *
 * - Por CNPJ (Fisioterapeuta): usa a SP mínima dbo.sp_LoginFisioterapeutaPorCnpj_Min
 */
async function findUserByIdentifier(pool, { email, cpf, cnpj }) {
  const valorEmail = email ? String(email).trim() : null;
  const valorCpf = cpf ? normalizeDigits(cpf) : null;
  const valorCnpj = cnpj ? normalizeCNPJ(cnpj) : null;

  if (!valorEmail && !valorCpf && !valorCnpj) return null;

  // ==========================
  // 1) BUSCA POR EMAIL (e valida unicidade global)
  // ==========================
  if (valorEmail) {
    const rs = await pool
      .request()
      .input("Email", sql.NVarChar(300), valorEmail)
      .execute("dbo.sp_LoginPorEmail_Min");

    const matches = (rs.recordset || []).map((row) => ({
      tipo: normalizeTipoUsuario(row.Tipo),
      id: Number(row.Id),
      nome: row.Nome ?? null,
      email: row.Email ?? valorEmail,
      senhaHash: row.SenhaHash,
      ativo: to01(row.Ativo, 0),
      isBloqueado: to01(row.IsBloqueado, 0),
      cpf: row.Cpf ?? null,
      cnpj: row.Cnpj ?? null
    }));

    // Se existir em mais de um tipo, bloquear login e forçar correção do cadastro
    if (matches.length > 1) {
      const tipos = matches.map((m) => m.tipo).join(", ");
      log("warn", "[authService] Conflito de e-mail entre tipos de conta.", {
        email: valorEmail,
        tipos
      });
      const err = new Error("E-mail conflitante. Contate o suporte.");
      err.httpStatus = 403;
      throw err;
    }

    if (matches.length === 1) return matches[0];
  }

  // ==========================
  // 2) BUSCA POR CPF (Paciente)
  // ==========================
  if (valorCpf) {
    let r;
    try {
      r = await pool
        .request()
        .input("Cpf", sql.NVarChar(32), valorCpf)
        .execute("dbo.sp_LoginPacientePorCpf_Min");
    } catch (err) {
      log("error", "[authService] Erro ao consultar login por CPF.", { error: err?.message });
      throw new Error("Falha interna ao consultar login.");
    }

    const u = r.recordset?.[0];
    if (u) {
      return {
        tipo: "Paciente",
        id: Number(u.Id),
        nome: u.Nome ?? null,
        email: u.Email ?? null,
        senhaHash: u.SenhaHash,
        ativo: to01(u.Ativo, 0),
        isBloqueado: to01(u.IsBloqueado, 0),
        cpf: u.CPF ?? null
      };
    }
  }

  // ==========================
  // 3) BUSCA POR CNPJ (Fisioterapeuta)
  // ==========================
  if (valorCnpj) {
    let r;
    try {
      r = await pool
        .request()
        .input("Cnpj", sql.NVarChar(32), valorCnpj)
        .execute("dbo.sp_LoginFisioterapeutaPorCnpj_Min");
    } catch (err) {
      log("error", "[authService] Erro ao consultar login por CNPJ.", { error: err?.message });
      throw new Error("Falha interna ao consultar login.");
    }

    const u = r.recordset?.[0];
    if (u) {
      return {
        tipo: "Fisioterapeuta",
        id: Number(u.Id),
        nome: u.Nome ?? null,
        email: u.Email ?? null,
        senhaHash: u.SenhaHash,
        ativo: to01(u.Ativo, 0),
        isBloqueado: to01(u.IsBloqueado, 0),
        cnpj: u.CNPJ ?? null
      };
    }
  }

  return null;
}

async function getUserByTipoId(pool, tipo, id) {
  const t = normalizeTipoUsuario(tipo);
  const userId = Number(id);
  if (!t || !userId) return null;

  if (t === "Admin") {
    const r = await pool.request().input("Id", sql.Int, userId).query(`
      SELECT TOP 1 Id, Nome, Email, Ativo, NivelAcesso
      FROM dbo.Administradores
      WHERE Id = @Id;
    `);
    const u = r.recordset?.[0];
    if (!u) return null;
    return {
      tipo: "Admin",
      id: u.Id,
      nome: u.Nome,
      email: u.Email,
      ativo: to01(u.Ativo, 0),
      nivelAcesso: u.NivelAcesso ?? null
    };
  }

  if (t === "Paciente") {
    const r = await pool.request().input("Id", sql.Int, userId).query(`
      SELECT TOP 1 Id, Nome, Email, CPF, Ativo, ISNULL(IsBloqueado, 0) AS IsBloqueado
      FROM dbo.Pacientes
      WHERE Id = @Id;
    `);
    const u = r.recordset?.[0];
    if (!u) return null;
    return {
      tipo: "Paciente",
      id: u.Id,
      nome: u.Nome,
      email: u.Email,
      cpf: u.CPF,
      ativo: to01(u.Ativo, 0),
      isBloqueado: to01(u.IsBloqueado, 0)
    };
  }

  if (t === "Fisioterapeuta") {
    // OBS: se houver RLS, pode ser necessário criar uma SP mínima por Id.
    const r = await pool.request().input("Id", sql.Int, userId).query(`
      SELECT TOP 1 Id, Nome, Email, CNPJ, Ativo, ISNULL(IsBloqueado, 0) AS IsBloqueado
      FROM dbo.Fisioterapeutas
      WHERE Id = @Id;
    `);
    const u = r.recordset?.[0];
    if (!u) return null;
    return {
      tipo: "Fisioterapeuta",
      id: u.Id,
      nome: u.Nome,
      email: u.Email,
      cnpj: u.CNPJ,
      ativo: to01(u.Ativo, 0),
      isBloqueado: to01(u.IsBloqueado, 0)
    };
  }

  return null;
}

async function findUserByOAuthIdentity(pool, { provider, subject }) {
  const provedor = normalizeOAuthProvider(provider);
  const subjectNorm = normalizeOAuthSubject(subject);
  if (!provedor || !subjectNorm) return null;

  const r = await pool
    .request()
    .input("Provedor", sql.NVarChar(30), provedor)
    .input("Subject", sql.NVarChar(255), subjectNorm)
    .query(`
      IF OBJECT_ID(N'dbo.UsuarioOAuthIdentidades', N'U') IS NULL
      BEGIN
        SELECT TOP (0)
          CAST(NULL AS NVARCHAR(30)) AS UsuarioTipo,
          CAST(NULL AS INT) AS UsuarioId;
      END
      ELSE
      BEGIN
        SELECT TOP (1)
          UsuarioTipo,
          UsuarioId
        FROM dbo.UsuarioOAuthIdentidades
        WHERE Provedor = @Provedor
          AND Subject = @Subject
          AND RevogadoEm IS NULL;
      END
    `);

  const row = r.recordset?.[0];
  if (!row?.UsuarioTipo || !row?.UsuarioId) return null;
  return getUserByTipoId(pool, row.UsuarioTipo, Number(row.UsuarioId));
}

async function salvarOAuthIdentity(pool, { provider, subject, usuario, email, nome }) {
  const provedor = normalizeOAuthProvider(provider);
  const subjectNorm = normalizeOAuthSubject(subject);
  const tipo = normalizeTipoUsuario(usuario?.tipo);
  const usuarioId = Number(usuario?.id);
  if (!provedor || !subjectNorm || !tipo || !usuarioId) return;

  const emailNorm = email ? normalizeEmail(email) : null;

  await pool
    .request()
    .input("Provedor", sql.NVarChar(30), provedor)
    .input("Subject", sql.NVarChar(255), subjectNorm)
    .input("UsuarioTipo", sql.NVarChar(30), tipo)
    .input("UsuarioId", sql.Int, usuarioId)
    .input("EmailAtual", sql.NVarChar(300), emailNorm)
    .input("EmailRelay", sql.Bit, isApplePrivateRelayEmail(emailNorm) ? 1 : 0)
    .input("NomeAtual", sql.NVarChar(300), nome ? String(nome).trim().slice(0, 300) : null)
    .query(`
      IF OBJECT_ID(N'dbo.UsuarioOAuthIdentidades', N'U') IS NULL
        RETURN;

      DECLARE @AtualUsuarioTipo NVARCHAR(30), @AtualUsuarioId INT;

      SELECT TOP (1)
        @AtualUsuarioTipo = UsuarioTipo,
        @AtualUsuarioId = UsuarioId
      FROM dbo.UsuarioOAuthIdentidades WITH (UPDLOCK, HOLDLOCK)
      WHERE Provedor = @Provedor
        AND Subject = @Subject
        AND RevogadoEm IS NULL;

      IF @AtualUsuarioId IS NOT NULL
      BEGIN
        IF @AtualUsuarioTipo <> @UsuarioTipo OR @AtualUsuarioId <> @UsuarioId
          THROW 50091, 'Identidade OAuth vinculada a outra conta.', 1;

        UPDATE dbo.UsuarioOAuthIdentidades
        SET EmailAtual = COALESCE(@EmailAtual, EmailAtual),
            EmailRelay = CASE WHEN @EmailAtual IS NULL THEN EmailRelay ELSE @EmailRelay END,
            NomeAtual = COALESCE(@NomeAtual, NomeAtual),
            UltimoLoginEm = SYSDATETIME(),
            AtualizadoEm = SYSDATETIME()
        WHERE Provedor = @Provedor
          AND Subject = @Subject
          AND RevogadoEm IS NULL;

        RETURN;
      END;

      INSERT INTO dbo.UsuarioOAuthIdentidades
        (Provedor, Subject, UsuarioTipo, UsuarioId, EmailAtual, EmailRelay, NomeAtual, UltimoLoginEm)
      VALUES
        (@Provedor, @Subject, @UsuarioTipo, @UsuarioId, @EmailAtual, @EmailRelay, @NomeAtual, SYSDATETIME());
    `);
}
async function blacklistAccessToken(pool, { jti, exp }) {
  if (!jti || !exp) return;

  const expiraEm = new Date(Number(exp) * 1000);
  if (Number.isNaN(expiraEm.getTime())) return;

  await pool
    .request()
    .input("Jti", sql.Char(36), String(jti))
    .input("ExpiraEm", sql.DateTime2, expiraEm)
    .query(`
      IF NOT EXISTS (SELECT 1 FROM dbo.AccessTokenBlacklist WHERE Jti = @Jti)
      INSERT INTO dbo.AccessTokenBlacklist (Jti, ExpiraEm)
      VALUES (@Jti, @ExpiraEm);
    `);

  setCacheEntry(jti, true, exp);
}

export const authService = {
  /**
   * Login:
   * - Admin: email + senha
   * - Paciente: email OU CPF + senha
   * - Fisioterapeuta: email OU CNPJ + senha
   */
  async login(credenciais, reqLike = null) {
    const { email, cpf, cnpj, senha } = credenciais || {};

    if (!senha || (!email && !cpf && !cnpj)) {
      throw new Error("Informe e-mail, CPF ou CNPJ e a senha.");
    }

    if (!ENV.JWT_SECRET) throw new Error("JWT_SECRET não configurado.");

    const pool = await getPool();

    const usuario = await findUserByIdentifier(pool, { email, cpf, cnpj });
    if (!usuario) throw new Error("Usuário não encontrado.");

    usuario.tipo = normalizeTipoUsuario(usuario.tipo);

    // Revalida flags na tabela por Id (fonte de verdade)
    const freshFlags = await reloadAuthFlagsByTipoId(pool, usuario.tipo, usuario.id).catch(() => null);
    if (freshFlags) {
      usuario.ativo = freshFlags.ativo;
      usuario.isBloqueado = freshFlags.isBloqueado;
      usuario.nivelAcesso = freshFlags.nivelAcesso ?? usuario.nivelAcesso ?? null;
    } else {
      // Fail-safe
      usuario.ativo = to01(usuario.ativo, 0);
      usuario.isBloqueado = to01(usuario.isBloqueado, 0);
    }

    enforceAcessoLogin(usuario);
    await assertContaNaoBloqueada(pool, usuario);

    const hash = String(usuario.senhaHash || "");
    const senhaValida = await bcrypt.compare(String(senha), hash);
    if (!senhaValida) {
      const lockState = await registrarFalhaLoginConta(pool, usuario);
      const bloqueadoAte = lockState?.BloqueadoAte || lockState?.bloqueadoAte;
      const bloqueadoAgora = Number(lockState?.BloqueadoAgora ?? lockState?.bloqueadoAgora ?? 0) === 1;
      const segundosRestantes = Number(lockState?.SegundosRestantes ?? lockState?.segundosRestantes ?? 0);
      if (bloqueadoAgora || (bloqueadoAte && new Date(bloqueadoAte) > new Date())) {
        throw new Error(
          segundosRestantes > 0
            ? mensagemMuitasTentativasPorSegundos(segundosRestantes)
            : mensagemMuitasTentativas(bloqueadoAte)
        );
      }
      throw new Error("Senha incorreta.");
    }

    await registrarSucessoLoginConta(pool, usuario);

    // Access token com jti (para blacklist)
    const jti = crypto.randomUUID();
    const accessToken = jwt.sign(
      buildAccessTokenPayload({ id: usuario.id, tipo: usuario.tipo, nome: usuario.nome }, jti),
      ENV.JWT_SECRET,
      { expiresIn: ENV.TOKEN_EXPIRATION }
    );

    // Refresh token (armazenar hash)
    const refreshToken = newOpaqueToken();
    const refreshHash = sha256Hex(refreshToken);
    const expiraEm = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000);

    await pool
      .request()
      .input("UsuarioTipo", sql.NVarChar(30), usuario.tipo)
      .input("UsuarioId", sql.Int, Number(usuario.id))
      .input("TokenHash", sql.Char(64), refreshHash)
      .input("ExpiraEm", sql.DateTime2, expiraEm)
      .input("IpCriacao", sql.NVarChar(64), getClientIp(reqLike))
      .input("UserAgent", sql.NVarChar(400), getUserAgent(reqLike))
      .query(`
        INSERT INTO dbo.RefreshTokens
          (UsuarioTipo, UsuarioId, TokenHash, ExpiraEm, IpCriacao, UserAgent)
        VALUES
          (@UsuarioTipo, @UsuarioId, @TokenHash, @ExpiraEm, @IpCriacao, @UserAgent);
      `);

    return {
      mensagem: "Login bem-sucedido.",
      token: accessToken,
      refreshToken,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        tipo: usuario.tipo,
        NivelAcesso: usuario.nivelAcesso ?? null
      }
    };
  },

  /**
   * Login OAuth:
   * - busca usuário por identidade OAuth (provedor + subject) ou e-mail verificado
   * - revalida status (Ativo/IsBloqueado)
   * - emite access token + refresh token
   */
  async loginOAuth(payload, reqLike = null) {
    const provider = normalizeOAuthProvider(payload?.provedor);
    const subject = normalizeOAuthSubject(payload?.sub);
    const email = payload?.email ? normalizeEmail(payload.email) : null;

    if (!provider) throw new Error("Provedor OAuth inválido.");
    if (!subject && !email) throw new Error("Usuário não encontrado.");
    if (email && payload?.emailVerificado !== true) {
      throw new Error("Token OAuth inválido: e-mail não verificado.");
    }

    if (!ENV.JWT_SECRET) throw new Error("JWT_SECRET não configurado.");

    const pool = await getPool();

    let usuario = subject
      ? await findUserByOAuthIdentity(pool, { provider, subject })
      : null;

    if (!usuario && email) {
      usuario = await findUserByIdentifier(pool, { email, cpf: null, cnpj: null });
    }

    if (!usuario) throw new Error("Usuário não encontrado.");

    const freshFlags = await reloadAuthFlagsByTipoId(pool, usuario.tipo, usuario.id).catch(() => null);
    if (freshFlags) {
      usuario.ativo = freshFlags.ativo;
      usuario.isBloqueado = freshFlags.isBloqueado;
      usuario.nivelAcesso = freshFlags.nivelAcesso ?? usuario.nivelAcesso ?? null;
    } else {
      usuario.ativo = to01(usuario.ativo, 0);
      usuario.isBloqueado = to01(usuario.isBloqueado, 0);
    }

    enforceAcessoLogin(usuario);

    if (subject) {
      await salvarOAuthIdentity(pool, {
        provider,
        subject,
        usuario,
        email,
        nome: payload?.nome || null
      });
    }

    const jti = crypto.randomUUID();
    const accessToken = jwt.sign(
      buildAccessTokenPayload({ id: usuario.id, tipo: usuario.tipo, nome: usuario.nome }, jti),
      ENV.JWT_SECRET,
      { expiresIn: ENV.TOKEN_EXPIRATION }
    );

    const refreshToken = newOpaqueToken();
    const refreshHash = sha256Hex(refreshToken);
    const expiraEm = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000);

    await pool
      .request()
      .input("UsuarioTipo", sql.NVarChar(30), usuario.tipo)
      .input("UsuarioId", sql.Int, Number(usuario.id))
      .input("TokenHash", sql.Char(64), refreshHash)
      .input("ExpiraEm", sql.DateTime2, expiraEm)
      .input("IpCriacao", sql.NVarChar(64), getClientIp(reqLike))
      .input("UserAgent", sql.NVarChar(400), getUserAgent(reqLike))
      .query(`
        INSERT INTO dbo.RefreshTokens
          (UsuarioTipo, UsuarioId, TokenHash, ExpiraEm, IpCriacao, UserAgent)
        VALUES
          (@UsuarioTipo, @UsuarioId, @TokenHash, @ExpiraEm, @IpCriacao, @UserAgent);
      `);

    return {
      mensagem: "Login bem-sucedido.",
      token: accessToken,
      refreshToken,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        tipo: usuario.tipo,
        NivelAcesso: usuario.nivelAcesso ?? null
      }
    };
  },

  /**
   * Refresh:
   * - valida refresh token (hash) na dbo.RefreshTokens
   * - revalida status ANTES de rotacionar (evita inserir token novo para conta inativa/bloqueada)
   * - rotate: revoga o antigo e gera um novo
   * - emite novo access token
   */
  async refresh(refreshToken, reqLike = null) {
    if (!refreshToken) throw new Error("refreshToken é obrigatório.");
    if (!ENV.JWT_SECRET) throw new Error("JWT_SECRET não configurado.");

    const pool = await getPool();
    const oldHash = sha256Hex(refreshToken);

    const r = await pool
      .request()
      .input("TokenHash", sql.Char(64), oldHash)
      .query(`
        SELECT TOP 1
          UsuarioTipo, UsuarioId, TokenHash, ExpiraEm, RevogadoEm
        FROM dbo.RefreshTokens
        WHERE TokenHash = @TokenHash;
      `);

    const row = r.recordset?.[0];
    if (!row) throw new Error("Refresh token inválido.");
    if (row.RevogadoEm) throw new Error("Refresh token revogado.");
    if (new Date(row.ExpiraEm) <= new Date()) throw new Error("Refresh token expirado.");

    const user = await getUserByTipoId(pool, row.UsuarioTipo, Number(row.UsuarioId));
    if (!user) throw new Error("Usuário não encontrado.");

    const freshFlags = await reloadAuthFlagsByTipoId(pool, user.tipo, user.id).catch(() => null);
    if (freshFlags) {
      user.ativo = freshFlags.ativo;
      user.isBloqueado = freshFlags.isBloqueado;
      user.nivelAcesso = freshFlags.nivelAcesso ?? user.nivelAcesso ?? null;
    } else {
      user.ativo = to01(user.ativo, 0);
      user.isBloqueado = to01(user.isBloqueado, 0);
    }

    try {
      enforceAcessoLogin(user);
    } catch (e) {
      // Revoga o refresh atual (evita tentativas contínuas após desativação/bloqueio)
      await pool
        .request()
        .input("OldHash", sql.Char(64), oldHash)
        .input("Motivo", sql.NVarChar(120), "Conta desativada/bloqueada")
        .query(`
          UPDATE dbo.RefreshTokens
          SET RevogadoEm = SYSDATETIME(),
              RevogadoMotivo = @Motivo
          WHERE TokenHash = @OldHash AND RevogadoEm IS NULL;
        `);

      throw e;
    }

    // Rotaciona
    const newRt = newOpaqueToken();
    const newHash = sha256Hex(newRt);
    const expiraEm = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000);

    const upd = await pool
      .request()
      .input("OldHash", sql.Char(64), oldHash)
      .input("NewHash", sql.Char(64), newHash)
      .query(`
        UPDATE dbo.RefreshTokens
        SET RevogadoEm = SYSDATETIME(),
            RevogadoMotivo = N'Rotacionado',
            SubstituidoPorHash = @NewHash
        WHERE TokenHash = @OldHash AND RevogadoEm IS NULL;
      `);

    // Se não conseguiu revogar (corrida), não cria novo token
    if (!upd?.rowsAffected?.[0]) {
      throw new Error("Refresh token revogado.");
    }

    await pool
      .request()
      .input("UsuarioTipo", sql.NVarChar(30), row.UsuarioTipo)
      .input("UsuarioId", sql.Int, Number(row.UsuarioId))
      .input("TokenHash", sql.Char(64), newHash)
      .input("ExpiraEm", sql.DateTime2, expiraEm)
      .input("IpCriacao", sql.NVarChar(64), getClientIp(reqLike))
      .input("UserAgent", sql.NVarChar(400), getUserAgent(reqLike))
      .query(`
        INSERT INTO dbo.RefreshTokens
          (UsuarioTipo, UsuarioId, TokenHash, ExpiraEm, IpCriacao, UserAgent)
        VALUES
          (@UsuarioTipo, @UsuarioId, @TokenHash, @ExpiraEm, @IpCriacao, @UserAgent);
      `);

    const jti = crypto.randomUUID();
    const accessToken = jwt.sign(
      buildAccessTokenPayload({ id: user.id, tipo: user.tipo, nome: user.nome }, jti),
      ENV.JWT_SECRET,
      { expiresIn: ENV.TOKEN_EXPIRATION }
    );

    return {
      mensagem: "Token renovado com sucesso.",
      token: accessToken,
      refreshToken: newRt,
      usuario: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        tipo: user.tipo,
        NivelAcesso: user.nivelAcesso ?? null
      }
    };
  },

  /**
   * Logout:
   * - revoga refresh token (se enviado)
   * - opcional: inclui o access token atual na blacklist (se enviar accessToken)
   */
  async logout({ refreshToken, accessToken } = {}) {
    const pool = await getPool();

    if (refreshToken) {
      const hash = sha256Hex(refreshToken);
      await pool
        .request()
        .input("TokenHash", sql.Char(64), hash)
        .query(`
          UPDATE dbo.RefreshTokens
          SET RevogadoEm = SYSDATETIME(),
              RevogadoMotivo = N'Logout'
          WHERE TokenHash = @TokenHash AND RevogadoEm IS NULL;
        `);
    }

    // Blacklist access token (logout imediato)
    if (accessToken) {
      const decoded = jwt.decode(accessToken);
      const jti = decoded?.jti || null;
      const exp = decoded?.exp || null;
      await blacklistAccessToken(pool, { jti, exp });
    }

    return { sucesso: true, mensagem: "Logout realizado." };
  },

  /**
   * Utilitário para o middleware:
   * retorna true se o jti estiver na blacklist e ainda não expirou.
   */
  async isAccessTokenRevoked(jti, exp = null) {
    if (!jti) return false;

    const cached = getCacheEntry(jti);
    if (cached) return cached.revoked;

    const pool = await getPool();

    const r = await pool
      .request()
      .input("Jti", sql.Char(36), String(jti))
      .query(`
        SELECT TOP 1 Jti, ExpiraEm
        FROM dbo.AccessTokenBlacklist
        WHERE Jti = @Jti AND ExpiraEm > SYSDATETIME();
      `);

    const row = r.recordset?.[0] || null;
    const revoked = Boolean(row);

    if (row?.ExpiraEm) {
      const expiraMs = new Date(row.ExpiraEm).getTime();
      const expiraSec = Number.isFinite(expiraMs) ? Math.floor(expiraMs / 1000) : exp;
      setCacheEntry(jti, true, expiraSec);
    } else {
      setCacheEntry(jti, false, exp, ACCESS_TOKEN_CACHE_FALLBACK_TTL_MS);
    }

    return revoked;
  },

  /**
   * (Opcional) limpeza de registros expirados (pode rodar em job)
   */
  async limparExpirados() {
    const pool = await getPool();

    let totalBlacklist = 0;
    let totalRefresh = 0;

    // Processa em lotes para reduzir lock/tempo de transação em bases grandes.
    while (true) {
      const r = await pool.request().query(`
        DECLARE @DelBlacklist INT = 0;
        DECLARE @DelRefresh INT = 0;

        DELETE TOP (1000)
        FROM dbo.AccessTokenBlacklist
        WHERE ExpiraEm <= SYSDATETIME();
        SET @DelBlacklist = @@ROWCOUNT;

        DELETE TOP (1000)
        FROM dbo.RefreshTokens
        WHERE ExpiraEm <= SYSDATETIME();
        SET @DelRefresh = @@ROWCOUNT;

        SELECT @DelBlacklist AS DelBlacklist, @DelRefresh AS DelRefresh;
      `);

      const delBlacklist = Number(r.recordset?.[0]?.DelBlacklist ?? 0);
      const delRefresh = Number(r.recordset?.[0]?.DelRefresh ?? 0);

      totalBlacklist += delBlacklist;
      totalRefresh += delRefresh;

      if (delBlacklist === 0 && delRefresh === 0) break;
    }

    return {
      sucesso: true,
      removidos: {
        accessTokenBlacklist: totalBlacklist,
        refreshTokens: totalRefresh
      }
    };
  }
};

export default authService;
