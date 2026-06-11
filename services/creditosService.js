//  services/creditosService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeStatus(v) {
  const s = (v === undefined || v === null) ? null : String(v).trim();
  return s && s.length ? s : null;
}

function normalizePagination(limit, offset) {
  const lim = Number(limit);
  const off = Number(offset);
  return {
    limit: Math.min(Math.max(Number.isFinite(lim) ? Math.trunc(lim) : 50, 1), 200),
    offset: Math.max(Number.isFinite(off) ? Math.trunc(off) : 0, 0)
  };
}

export default {
  /**
   * Retorna o saldo disponível (carteira) do paciente logado.
   * - saldoDisponivel = SUM(Valor) onde Status='Disponivel'
   */
  async saldo(usuario) {
    const pacienteId = toInt(usuario?.id);
    if (!pacienteId) {
      throw new HttpError(400, 'PacienteId inválido.');
    }

    const r = await queryWithContext(
      usuario,
      (req) => req.input('PacienteId', sql.Int, pacienteId),
      `
      SELECT
        -- Saldo LIVRE (carteira): PacoteId IS NULL
        CAST(ISNULL(SUM(
          CASE
            WHEN LTRIM(RTRIM(ISNULL(cp.Status, N''))) = N'Disponivel'
             AND cp.UsadoEm IS NULL
             AND cp.Valor > 0
             AND cp.PacoteId IS NULL
            THEN cp.Valor ELSE 0
          END
        ), 0) AS DECIMAL(10,2)) AS SaldoLivre,

        -- Saldo de PACOTES: PacoteId IS NOT NULL + pacote ATIVO
        CAST(ISNULL(SUM(
          CASE
            WHEN LTRIM(RTRIM(ISNULL(cp.Status, N''))) = N'Disponivel'
             AND cp.UsadoEm IS NULL
             AND cp.Valor > 0
             AND cp.PacoteId IS NOT NULL
             AND p.Id IS NOT NULL
            THEN cp.Valor ELSE 0
          END
        ), 0) AS DECIMAL(10,2)) AS SaldoPacotes
      FROM dbo.CreditosPacientes cp
      LEFT JOIN dbo.Pacotes p
        ON p.Id = cp.PacoteId
       AND LTRIM(RTRIM(ISNULL(p.Status, N''))) = N'Ativo'
      WHERE cp.PacienteId = @PacienteId;
      `
    );

    const row = r?.recordset?.[0] || {};

    const saldoLivre = Number(row.SaldoLivre ?? 0) || 0;
    const saldoPacotes = Number(row.SaldoPacotes ?? 0) || 0;
    const saldoTotal = Number((saldoLivre + saldoPacotes).toFixed(2));

    return {
      pacienteId,
      saldoLivre,
      saldoPacotes,
      saldoTotal
    };
  },

  /**
   * Lista créditos do paciente logado.
   * Query opcional:
   * - status=Disponivel|Usado|...
   * - limit=1..200 (default 50)
   * - offset>=0 (default 0)
   */
  async listar(usuario, { status, limit = 50, offset = 0 } = {}) {
    const pacienteId = toInt(usuario?.id);
    if (!pacienteId) {
      throw new HttpError(400, 'PacienteId inválido.');
    }

    const statusNorm = normalizeStatus(status);
    const pag = normalizePagination(limit, offset);

    const r = await queryWithContext(
      usuario,
      (req) => {
        req.input('PacienteId', sql.Int, pacienteId);
        req.input('Status', sql.NVarChar(60), statusNorm);
        req.input('Limit', sql.Int, pag.limit);
        req.input('Offset', sql.Int, pag.offset);
      },
      `
      ;WITH Base AS (
        SELECT
          Id,
          PacienteId,
          ConsultaId,
          OrigemConsultaId,
          PacoteId,
          OrigemPacoteId,
          CAST(Valor AS DECIMAL(10,2)) AS Valor,
          Status,
          CriadoEm,
          UsadoEm,
          UltimaMovimentacaoEm,
          Motivo
        FROM dbo.CreditosPacientes
        WHERE PacienteId = @PacienteId
          AND (@Status IS NULL OR Status = @Status)
      )
      SELECT COUNT(1) AS Total FROM Base;

      ;WITH Base AS (
        SELECT
          Id,
          PacienteId,
          ConsultaId,
          OrigemConsultaId,
          PacoteId,
          OrigemPacoteId,
          CAST(Valor AS DECIMAL(10,2)) AS Valor,
          Status,
          CriadoEm,
          UsadoEm,
          UltimaMovimentacaoEm,
          Motivo
        FROM dbo.CreditosPacientes
        WHERE PacienteId = @PacienteId
          AND (@Status IS NULL OR Status = @Status)
      )
      SELECT
        Id,
        PacienteId,
        ConsultaId,
        OrigemConsultaId,
        PacoteId,
        OrigemPacoteId,
        Valor,
        Status,
        CriadoEm,
        UsadoEm,
        UltimaMovimentacaoEm,
        Motivo
      FROM Base
      ORDER BY COALESCE(UltimaMovimentacaoEm, UsadoEm, CriadoEm) DESC, Id DESC
      OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `
    );

    return {
      total: r?.recordsets?.[0]?.[0]?.Total ?? 0,
      limit: pag.limit,
      offset: pag.offset,
      itens: r?.recordsets?.[1] || []
    };
  }
};
