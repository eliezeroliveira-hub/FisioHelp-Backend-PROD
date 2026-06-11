// 📁 services/administradoresService.js
import bcrypt from 'bcrypt';
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';
import { validatePasswordStrength } from '../utils/passwordPolicy.js';

function safeUsuario(usuario) {
  return (usuario && usuario.id && usuario.tipo) ? usuario : null;
}

function requireUsuario(usuario) {
  const ctx = safeUsuario(usuario);
  if (!ctx) throw new HttpError(401, 'Usuário não autenticado.');
  return ctx;
}

function normalizeNivelAcesso(v) {
  const x = String(v || '').trim().toLowerCase();
  if (x === 'master') return 'Master';
  if (x === 'financeiro') return 'Financeiro';
  if (x === 'suporte') return 'Suporte';
  return null;
}

function normalizeEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return e || null;
}

function isValidEmailBasic(email) {
  // validação simples (suficiente p/ evitar lixo e dar feedback cedo)
  // (não tenta cobrir 100% do RFC)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function validateNome(nome) {
  const n = String(nome ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();

  // Alinha com CK_Admin_Nome (somente letras e espaços; sem números/caracteres especiais)
  const ok = /^[A-Za-zÀ-ÿ \-']+$/.test(n);
  if (!ok) {
    throw new HttpError(400, "Nome inválido. Use letras, espaços, hífen e apóstrofo (sem números).");
  }
  return n;
}

function validateSenhaNova(senha) {
  return validatePasswordStrength(senha, { fieldLabel: 'Senha nova' });
}

async function getMeuNivelAcesso(usuario) {
  const ctx = requireUsuario(usuario);

  const r = await queryWithContext(
    ctx,
    (req) => req.input('Id', sql.Int, Number(ctx.id)),
    `
      SELECT TOP 1 NivelAcesso, Ativo
      FROM dbo.Administradores
      WHERE Id = @Id;
    `,
    { requireContext: true }
  );

  const row = r.recordset?.[0];
  if (!row) throw new HttpError(404, 'Administrador não encontrado.');
  if (Number(row.Ativo) !== 1) throw new HttpError(403, 'Administrador inativo.');

  return String(row.NivelAcesso || '');
}

async function ensureMaster(usuario) {
  const ctx = requireUsuario(usuario);
  if (String(ctx.tipo).toLowerCase() !== 'admin') {
    throw new HttpError(403, 'Acesso negado: apenas administradores podem executar esta ação.');
  }
  const nivel = await getMeuNivelAcesso(usuario);
  if (String(nivel).toLowerCase() !== 'master') {
    throw new HttpError(403, 'Acesso negado: apenas Admin Master pode executar esta ação.');
  }
  return ctx;
}

const administradoresService = {
  async listar(usuario) {
    const ctx = await ensureMaster(usuario);

    const r = await queryWithContext(
      ctx,
      null,
      `
        SELECT Id, Nome, Email, NivelAcesso, Ativo
        FROM dbo.Administradores
        ORDER BY Nome ASC;
      `,
      { requireContext: true }
    );

    return r.recordset || [];
  },

  //CRIAR
  async criar(dados = {}, usuario) {
    const ctx = await ensureMaster(usuario);

    // aceita camelCase e PascalCase
    const nomeRaw = dados.nome ?? dados.Nome ?? null;
    const emailRaw = dados.email ?? dados.Email ?? null;
    const senhaRaw = dados.senha ?? dados.Senha ?? null;
    const nivelAcessoRaw = dados.nivelAcesso ?? dados.NivelAcesso ?? null;
    const ativoRaw = (dados.ativo ?? dados.Ativo ?? 1);

    if (!nomeRaw) {
      throw new HttpError(400, 'Nome é obrigatório.');
    }

    const Nome = validateNome(nomeRaw);

    const Email = normalizeEmail(emailRaw);
    if (!Email) {
      throw new HttpError(400, 'Email é obrigatório.');
    }

    if (!isValidEmailBasic(Email)) {
      throw new HttpError(400, 'E-mail inválido.');
    }

    const NivelAcesso = normalizeNivelAcesso(nivelAcessoRaw);
    if (!NivelAcesso) {
      throw new HttpError(400, "NivelAcesso inválido. Use: 'Master', 'Financeiro' ou 'Suporte'.");
    }

    const senhaNova = validateSenhaNova(senhaRaw);
    const SenhaHash = await bcrypt.hash(senhaNova, 12);

    // aceita boolean, número e string
    const Ativo =
      (ativoRaw === false || ativoRaw === 0 || ativoRaw === '0' || ativoRaw === 'false') ? 0 : 1;

    let r;
    try {
      r = await queryWithContext(
        ctx,
        (req) => {
          req.input('Nome', sql.NVarChar(300), Nome);
          req.input('Email', sql.NVarChar(300), Email);
          req.input('SenhaHash', sql.NVarChar(510), SenhaHash);
          req.input('NivelAcesso', sql.NVarChar(60), NivelAcesso);
          req.input('Ativo', sql.Bit, Ativo);
        },
        `
          SET XACT_ABORT ON;

          IF EXISTS (SELECT 1 FROM dbo.Administradores WHERE Email = @Email)
            THROW 50001, 'Já existe um administrador com este e-mail.', 1;

          DECLARE @Ids TABLE (Id INT);

          INSERT INTO dbo.Administradores (Nome, Email, SenhaHash, NivelAcesso, Ativo)
          OUTPUT inserted.Id INTO @Ids(Id)
          VALUES (@Nome, @Email, @SenhaHash, @NivelAcesso, @Ativo);

          DECLARE @NewId INT = (SELECT TOP 1 Id FROM @Ids);

          SELECT
            Id, Nome, Email, NivelAcesso, Ativo
          FROM dbo.Administradores
          WHERE Id = @NewId;
        `,
        { requireContext: true }
      );
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('Já existe um administrador com este e-mail.') || err?.number === 2601 || err?.number === 2627) {
        throw new HttpError(409, 'E-mail já cadastrado.');
      }
      throw err;
    }

    return r.recordset?.[0] || null;
  },



  async alterarMinhaSenha({ senhaAtual, senhaNova } = {}, usuario) {
    const ctx = requireUsuario(usuario);
    if (String(ctx.tipo).toLowerCase() !== 'admin') throw new HttpError(403, 'Acesso negado.');

    const nova = validateSenhaNova(senhaNova);

    // Busca hash atual
    const r1 = await queryWithContext(
      ctx,
      (req) => req.input('Id', sql.Int, Number(ctx.id)),
      `
        SELECT TOP 1 SenhaHash, Ativo
        FROM dbo.Administradores
        WHERE Id = @Id;
      `,
      { requireContext: true }
    );

    const row = r1.recordset?.[0];
    if (!row) throw new HttpError(404, 'Administrador não encontrado.');
    if (Number(row.Ativo) !== 1) throw new HttpError(403, 'Administrador inativo.');
    if (!senhaAtual) throw new HttpError(400, 'senhaAtual é obrigatória.');

    const ok = await bcrypt.compare(String(senhaAtual), String(row.SenhaHash || ''));
    if (!ok) throw new HttpError(401, 'Senha atual incorreta.');

    const hashNovo = await bcrypt.hash(String(nova), 12);

    await queryWithContext(
      ctx,
      (req) => {
        req.input('Id', sql.Int, Number(ctx.id));
        req.input('SenhaHash', sql.NVarChar(510), hashNovo);
      },
      `
        UPDATE dbo.Administradores
        SET SenhaHash = @SenhaHash
        WHERE Id = @Id;
      `,
      { requireContext: true }
    );

    return { sucesso: true };
  },

  async resetarSenha(adminId, { senhaNova } = {}, usuario) {
    const ctx = await ensureMaster(usuario);

    const alvoId = Number(adminId);
    if (!Number.isFinite(alvoId) || alvoId <= 0) throw new HttpError(400, 'Id inválido.');
    if (alvoId === Number(ctx.id)) {
      throw new HttpError(403, 'Ação não permitida: use alterarMinhaSenha para trocar sua própria senha.');
    }

    const nova = validateSenhaNova(senhaNova);
    const hashNovo = await bcrypt.hash(String(nova), 12);

    try {
      await queryWithContext(
        ctx,
        (req) => {
          req.input('Id', sql.Int, alvoId);
          req.input('SenhaHash', sql.NVarChar(510), hashNovo);
        },
        `
          IF NOT EXISTS (SELECT 1 FROM dbo.Administradores WHERE Id = @Id)
            THROW 50002, 'Administrador não encontrado.', 1;

          UPDATE dbo.Administradores
          SET SenhaHash = @SenhaHash
          WHERE Id = @Id;
        `,
        { requireContext: true }
      );
    } catch (err) {
      if (String(err?.message || '').includes('Administrador não encontrado.')) {
        throw new HttpError(404, 'Administrador não encontrado.');
      }
      throw err;
    }

    return { sucesso: true };
  },

  async alterarNivelAcesso(adminId, dados = {}, usuario) {
    const ctx = await ensureMaster(usuario);

    const alvoId = Number(adminId);
    if (!Number.isFinite(alvoId) || alvoId <= 0) throw new HttpError(400, 'Id inválido.');

    const nivelAcessoRaw = dados.nivelAcesso ?? dados.NivelAcesso ?? null;
    const NivelAcesso = normalizeNivelAcesso(nivelAcessoRaw);
    if (!NivelAcesso) {
      throw new HttpError(400, "NivelAcesso inválido. Use: 'Master', 'Financeiro' ou 'Suporte'.");
    }

    if (alvoId === Number(ctx.id) && String(NivelAcesso).toLowerCase() !== 'master') {
      throw new HttpError(403, 'Ação não permitida: Admin Master não pode reduzir o próprio nível de acesso.');
    }

    try {
      const r = await queryWithContext(
        ctx,
        (req) => {
          req.input('Id', sql.Int, alvoId);
          req.input('NivelAcesso', sql.NVarChar(60), NivelAcesso);
        },
        `
          IF NOT EXISTS (SELECT 1 FROM dbo.Administradores WHERE Id = @Id)
            THROW 50002, 'Administrador não encontrado.', 1;

          UPDATE dbo.Administradores
          SET NivelAcesso = @NivelAcesso
          WHERE Id = @Id;

          SELECT Id, Nome, Email, NivelAcesso, Ativo
          FROM dbo.Administradores
          WHERE Id = @Id;
        `,
        { requireContext: true }
      );

      return r.recordset?.[0] || null;
    } catch (err) {
      if (String(err?.message || '').includes('Administrador não encontrado.')) {
        throw new HttpError(404, 'Administrador não encontrado.');
      }
      throw err;
    }
  },

  async setAtivo(adminId, ativo, usuario) {
    const ctx = await ensureMaster(usuario);

    const alvoId = Number(adminId);
    if (!Number.isFinite(alvoId) || alvoId <= 0) throw new HttpError(400, 'Id inválido.');

    const Ativo = (Number(ativo) === 0 ? 0 : 1);
    if (alvoId === Number(ctx.id) && Ativo === 0) {
      throw new HttpError(403, 'Ação não permitida: Admin Master não pode se auto-desativar.');
    }

    try {
      await queryWithContext(
        ctx,
        (req) => {
          req.input('Id', sql.Int, alvoId);
          req.input('Ativo', sql.Bit, Ativo);
        },
        `
          IF NOT EXISTS (SELECT 1 FROM dbo.Administradores WHERE Id = @Id)
            THROW 50002, 'Administrador não encontrado.', 1;

          UPDATE dbo.Administradores
          SET Ativo = @Ativo
          WHERE Id = @Id;
        `,
        { requireContext: true }
      );
    } catch (err) {
      if (String(err?.message || '').includes('Administrador não encontrado.')) {
        throw new HttpError(404, 'Administrador não encontrado.');
      }
      throw err;
    }

    return { sucesso: true, Ativo };
  }
};

export default administradoresService;
