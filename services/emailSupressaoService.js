import { sql } from '../config/dbConfig.js';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { isValidEmail, normalizeEmail } from '../utils/identityValidators.js';
import { queryWithContext } from './_queryWithContext.js';

const MOTIVOS_VALIDOS = new Set(['Bounce', 'Complaint', 'Suppressed', 'Manual']);
const PROVIDERS_VALIDOS = new Set(['acs', 'ses', 'manual']);

function contextoSistema() {
  return { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
}

function normalizarEmailSupressao(email) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized) || normalized.length > 320) return null;
  return normalized;
}

function normalizarMotivo(motivo) {
  const value = String(motivo || '').trim();
  return MOTIVOS_VALIDOS.has(value) ? value : null;
}

function normalizarProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return PROVIDERS_VALIDOS.has(value) ? value : null;
}

function serializarDetalhe(detalhe) {
  if (detalhe === null || detalhe === undefined) return null;
  if (typeof detalhe === 'string') {
    const texto = detalhe.trim();
    if (!texto) return null;
    try {
      JSON.parse(texto);
      return texto;
    } catch {
      return JSON.stringify({ raw: texto });
    }
  }

  try {
    return JSON.stringify(detalhe);
  } catch {
    return JSON.stringify({ erro: 'Detalhe não pôde ser serializado.' });
  }
}

async function emailEstaSuprimido(email) {
  const normalized = normalizarEmailSupressao(email);
  if (!normalized) return false;

  const result = await queryWithContext(contextoSistema(), (req) => {
    req.input('Email', sql.NVarChar(320), normalized);
  }, `
    IF OBJECT_ID(N'dbo.EmailSupressao', N'U') IS NULL
    BEGIN
      SELECT CAST(0 AS BIT) AS Suprimido;
      RETURN;
    END;

    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM dbo.EmailSupressao
        WHERE Email = @Email
      )
      THEN CAST(1 AS BIT)
      ELSE CAST(0 AS BIT)
    END AS Suprimido;
  `, { requireContext: true });

  return Number(result.recordset?.[0]?.Suprimido ?? 0) === 1;
}

async function suprimirEmail({ email, motivo, provider, detalhe = null }) {
  const normalized = normalizarEmailSupressao(email);
  const motivoNorm = normalizarMotivo(motivo);
  const providerNorm = normalizarProvider(provider);

  if (!normalized) {
    log('warn', 'Evento de supressão ignorado por e-mail inválido', { provider, motivo });
    return { ok: false, motivo: 'email_invalido' };
  }
  if (!motivoNorm || !providerNorm) {
    log('warn', 'Evento de supressão ignorado por motivo/provider inválido', {
      email: normalized,
      motivo,
      provider,
    });
    return { ok: false, motivo: 'classificacao_invalida' };
  }

  const detalheJson = serializarDetalhe(detalhe);

  const result = await queryWithContext(contextoSistema(), (req) => {
    req.input('Email', sql.NVarChar(320), normalized);
    req.input('Motivo', sql.NVarChar(30), motivoNorm);
    req.input('Provider', sql.NVarChar(20), providerNorm);
    req.input('DetalheJson', sql.NVarChar(sql.MAX), detalheJson);
  }, `
    IF OBJECT_ID(N'dbo.EmailSupressao', N'U') IS NULL
    BEGIN
      THROW 51000, 'Tabela dbo.EmailSupressao não encontrada. Aplique EMAIL_SUPRESSAO_V112.sql.', 1;
    END;

    MERGE dbo.EmailSupressao WITH (HOLDLOCK) AS alvo
    USING (
      SELECT
        @Email AS Email,
        @Motivo AS Motivo,
        @Provider AS Provider,
        @DetalheJson AS DetalheJson
    ) AS origem
      ON alvo.Email = origem.Email
    WHEN MATCHED THEN
      UPDATE SET
        Motivo = origem.Motivo,
        Provider = origem.Provider,
        DetalheJson = origem.DetalheJson,
        AtualizadoEm = SYSDATETIME()
    WHEN NOT MATCHED THEN
      INSERT (Email, Motivo, Provider, DetalheJson, CriadoEm, AtualizadoEm)
      VALUES (origem.Email, origem.Motivo, origem.Provider, origem.DetalheJson, SYSDATETIME(), SYSDATETIME())
    OUTPUT inserted.Id, inserted.Email, inserted.Motivo, inserted.Provider;
  `, { requireContext: true });

  const row = result.recordset?.[0] || null;
  return {
    ok: true,
    id: row?.Id ?? null,
    email: row?.Email ?? normalized,
    motivo: row?.Motivo ?? motivoNorm,
    provider: row?.Provider ?? providerNorm,
  };
}

export {
  emailEstaSuprimido,
  suprimirEmail,
};

export default {
  emailEstaSuprimido,
  suprimirEmail,
};
