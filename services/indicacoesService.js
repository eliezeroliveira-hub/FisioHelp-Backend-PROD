// 📁 services/indicacoesService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

const tipoLower = (u) => String(u?.tipo || '').toLowerCase();
const isAdmin = (u) => tipoLower(u) === 'admin';
const isFisio = (u) => tipoLower(u) === 'fisioterapeuta';

function assertUser(usuario) {
  if (!usuario?.id || !usuario?.tipo) throw new HttpError(401, 'Não autenticado.');
}

function assertInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} inválido.`);
  return n;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeQueryText(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s.slice(0, 50) : null;
}

const indicacoesService = {
  /**
   * GET /indicacoes/minhas
   * Fisio: lista indicações onde ele é o IndicadorId
   * Admin: opcionalmente pode passar indicadorId (se quiser)
   */
  async listarMinhas(usuario, { indicadorId = null, limit = 50, offset = 0, status = null } = {}) {
    assertUser(usuario);

    const lim = clamp(Number(limit) || 50, 1, 200);
    const off = Math.max(0, Number(offset) || 0);
    const st = normalizeQueryText(status);

    let indicadorFinal;

    if (isAdmin(usuario)) {
      indicadorFinal = indicadorId ? assertInt(indicadorId, 'indicadorId') : null;
    } else {
      if (!isFisio(usuario)) throw new HttpError(403, 'Acesso negado.');
      indicadorFinal = assertInt(usuario.id, 'Usuário');
    }

    const result = await queryWithContext(
      usuario,
      (req) => {
        req.input('IndicadorId', sql.Int, indicadorFinal);
        req.input('Status', sql.VarChar(20), st);
        req.input('Limit', sql.Int, lim);
        req.input('Offset', sql.Int, off);
      },
      `
      ;WITH Base AS (
        SELECT
          Id,
          IndicadorId,
          IndicadoId,
          DataIndicacao,
          CodigoUsado,
          Status,
          BonusConcedidoEm,
          MesesPremium,
          BonusIndicadorConcedidoEm,
          BonusIndicadoConcedidoEm
        FROM dbo.vw_Indicacoes
        WHERE
          (@IndicadorId IS NULL OR IndicadorId = @IndicadorId)
          AND (@Status IS NULL OR Status = @Status)
      )
      SELECT COUNT(1) AS Total
      FROM Base;

      ;WITH Base AS (
        SELECT
          Id,
          IndicadorId,
          IndicadoId,
          DataIndicacao,
          CodigoUsado,
          Status,
          BonusConcedidoEm,
          MesesPremium,
          BonusIndicadorConcedidoEm,
          BonusIndicadoConcedidoEm
        FROM dbo.vw_Indicacoes
        WHERE
          (@IndicadorId IS NULL OR IndicadorId = @IndicadorId)
          AND (@Status IS NULL OR Status = @Status)
      )
      SELECT
        b.Id,
        b.IndicadorId,
        fRef.Nome AS IndicadorNome,
        b.IndicadoId,
        fInd.Nome AS NomeIndicado,
        b.DataIndicacao,
        b.CodigoUsado,
        b.Status,
        b.BonusConcedidoEm,
        b.MesesPremium,
        b.BonusIndicadorConcedidoEm,
        b.BonusIndicadoConcedidoEm
      FROM Base b
      LEFT JOIN dbo.Fisioterapeutas fRef ON fRef.Id = b.IndicadorId
      LEFT JOIN dbo.Fisioterapeutas fInd ON fInd.Id = b.IndicadoId
      ORDER BY
        ISNULL(b.DataIndicacao, '1900-01-01') DESC,
        b.Id DESC
      OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `
    );

    return {
      total: result?.recordsets?.[0]?.[0]?.Total ?? 0,
      limit: lim,
      offset: off,
      itens: result?.recordsets?.[1] || []
    };
  },

  /**
   * GET /indicacoes/meu-codigo
   * Fisio: retorna o código já gerado no cadastro.
   */
  async meuCodigo(usuario) {
    assertUser(usuario);
    if (!isFisio(usuario) && !isAdmin(usuario)) throw new HttpError(403, 'Acesso negado.');

    // Para o fluxo do FIsioterapeuta: sempre o próprio id
    // (Admin pode ter rota admin separada se quiser consultar de outros)
    const fisioId = assertInt(usuario.id, 'Usuário');

    const result = await queryWithContext(
      usuario,
      (req) => req.input('FisioterapeutaId', sql.Int, fisioId),
      `
      SELECT TOP 1
        Id,
        FisioterapeutaId,
        Codigo,
        CriadoEm
      FROM dbo.CodigosIndicacao
      WHERE FisioterapeutaId = @FisioterapeutaId
      ORDER BY CriadoEm DESC, Id DESC;
      `
    );

    const row = result.recordset?.[0];
    if (!row) {
      throw new HttpError(404, 'Código de indicação não encontrado para este fisioterapeuta.');
    }

    return {
      id: row.Id,
      fisioterapeutaId: row.FisioterapeutaId,
      codigo: row.Codigo,
      criadoEm: row.CriadoEm
    };
  }
};

export { HttpError };
export default indicacoesService;
