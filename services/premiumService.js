// 📁 services/premiumService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

function asTipo(usuario) {
  return String(usuario?.tipo || '').toLowerCase();
}
function isFisio(usuario) {
  return asTipo(usuario) === 'fisioterapeuta';
}
function isAdmin(usuario) {
  return asTipo(usuario) === 'admin';
}
function assertUser(usuario) {
  if (!usuario?.id || !usuario?.tipo) throw new HttpError(401, 'Não autenticado.');
}
function assertInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} inválido.`);
  return n;
}

function mapRow(row) {
  if (!row) return null;

  return {
    FisioterapeutaId: row.FisioterapeutaId,
    TipoContaAtual: row.TipoContaAtual, // vindo de dbo.Fisioterapeutas (DB manda)
    Assinatura: row.Plano
      ? {
          Plano: row.Plano,
          ValorMensal: row.ValorMensal,
          DataInicio: row.DataInicio,
          DataFim: row.DataFim,
          Ativa: row.Ativa,
        }
      : null,
    IsPremium: !!row.IsPremium,
    NowDb: row.NowDb, // útil p/ debug
  };
}

const premiumService = {
  /**
   * GET /fisio/premium
   * Read-only. Somente o fisio logado.
   */
  async statusMe(usuario) {
    assertUser(usuario);
    if (!isFisio(usuario) && !isAdmin(usuario)) throw new HttpError(403, 'Acesso negado.');

    const fisioterapeutaId = assertInt(usuario.id, 'Usuário');

    const result = await queryWithContext(
      usuario,
      (req) => {
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      },
      `
      SELECT
        f.Id AS FisioterapeutaId,
        f.TipoConta AS TipoContaAtual,
        ap.Plano,
        ap.ValorMensal,
        ap.DataInicio,
        ap.DataFim,
        ap.Ativa,
        CASE
          WHEN ap.Ativa = 1 AND (ap.DataFim IS NULL OR ap.DataFim >= GETDATE()) THEN 1
          ELSE 0
        END AS IsPremium,
        GETDATE() AS NowDb
      FROM dbo.Fisioterapeutas f
      OUTER APPLY (
        SELECT TOP 1
          Plano, ValorMensal, DataInicio, DataFim, Ativa
        FROM dbo.AssinaturasPremium
        WHERE FisioterapeutaId = f.Id
          AND (Plano = N'Premium' OR Plano IS NULL)
        ORDER BY DataInicio DESC, Id DESC
      ) ap
      WHERE f.Id = @FisioterapeutaId;
      `
    );

    const row = result.recordset?.[0];
    if (!row) throw new HttpError(404, 'Fisioterapeuta não encontrado.');

    return mapRow(row);
  },

  /**
   * (Opcional) ADMIN: consultar premium de um fisio específico
   * GET /fisio/premium/admin/:fisioterapeutaId
   */
  async statusPorFisio(fisioterapeutaId, usuario) {
    assertUser(usuario);
    if (!isAdmin(usuario)) throw new HttpError(403, 'Acesso negado.');

    const fid = assertInt(fisioterapeutaId, 'FisioterapeutaId');

    const result = await queryWithContext(
      usuario,
      (req) => {
        req.input('FisioterapeutaId', sql.Int, fid);
      },
      `
      SELECT
        f.Id AS FisioterapeutaId,
        f.TipoConta AS TipoContaAtual,
        ap.Plano,
        ap.ValorMensal,
        ap.DataInicio,
        ap.DataFim,
        ap.Ativa,
        CASE
          WHEN ap.Ativa = 1 AND (ap.DataFim IS NULL OR ap.DataFim >= GETDATE()) THEN 1
          ELSE 0
        END AS IsPremium,
        GETDATE() AS NowDb
      FROM dbo.Fisioterapeutas f
      OUTER APPLY (
        SELECT TOP 1
          Plano, ValorMensal, DataInicio, DataFim, Ativa
        FROM dbo.AssinaturasPremium
        WHERE FisioterapeutaId = f.Id
          AND (Plano = N'Premium' OR Plano IS NULL)
        ORDER BY DataInicio DESC, Id DESC
      ) ap
      WHERE f.Id = @FisioterapeutaId;
      `
    );

    const row = result.recordset?.[0];
    if (!row) throw new HttpError(404, 'Fisioterapeuta não encontrado.');

    return mapRow(row);
  },
};
export default premiumService;
