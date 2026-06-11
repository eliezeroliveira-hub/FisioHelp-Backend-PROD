// 📁 services/favoritosService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function isUniqueViolation(err) {
  const num = Number(err?.number);
  const msg = String(err?.message || '').toLowerCase();
  return num === 2601 || num === 2627 || msg.includes('ux_favoritos_paciente_fisioterapeuta');
}

export default {
  async listar(usuario) {
    const pacienteId = toInt(usuario?.id);
    const r = await queryWithContext(
      usuario,
      (req) => req.input('PacienteId', sql.Int, pacienteId),
      `
      SELECT
        fav.Id               AS FavoritoId,
        fav.FisioterapeutaId,
        fav.DataAdicionado,
        vp.Nome,
        vp.CREFITO,
        vp.Especialidade,
        vp.FotoPerfilUrl,
        -- A view pública expõe apenas ValorConsulta (já com taxas). Mantemos os aliases para compatibilidade.
        vp.ValorConsulta       AS ValorConsultaBruto,
        vp.ValorConsulta       AS ValorConsultaFinal,
        vp.ToleranciaCancelamentoMinutos
      FROM dbo.Favoritos fav
      INNER JOIN dbo.vw_FisioterapeutaPerfilPublico vp
        ON vp.FisioterapeutaId = fav.FisioterapeutaId
      WHERE fav.PacienteId = @PacienteId
      ORDER BY fav.DataAdicionado DESC, fav.Id DESC;
      `
    );
    return r.recordset || [];
  },

  async adicionar(usuario, fisioterapeutaId) {
    const pacienteId = toInt(usuario?.id);
    const fisioId = toInt(fisioterapeutaId);
    if (!pacienteId || !fisioId) throw new HttpError(400, 'Parâmetros inválidos.');

    try {
      const ins = await queryWithContext(
        usuario,
        (req) => req
          .input('PacienteId', sql.Int, pacienteId)
          .input('FisioterapeutaId', sql.Int, fisioId),
        `
        INSERT INTO dbo.Favoritos (PacienteId, FisioterapeutaId, DataAdicionado)
        OUTPUT INSERTED.Id AS FavoritoId, INSERTED.PacienteId, INSERTED.FisioterapeutaId, INSERTED.DataAdicionado
        VALUES (@PacienteId, @FisioterapeutaId, SYSDATETIME());
        `
      );

      return ins.recordset?.[0] || null;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existente = await queryWithContext(
          usuario,
          (req) => req
            .input('PacienteId', sql.Int, pacienteId)
            .input('FisioterapeutaId', sql.Int, fisioId),
          `
          SELECT TOP 1 Id
          FROM dbo.Favoritos
          WHERE PacienteId = @PacienteId AND FisioterapeutaId = @FisioterapeutaId;
          `
        );

        const favId = existente.recordset?.[0]?.Id ?? null;
        if (favId) {
          return { FavoritoId: favId, PacienteId: pacienteId, FisioterapeutaId: fisioId, jaExistia: true };
        }

        throw new HttpError(409, 'Este fisioterapeuta já está nos favoritos.');
      }
      throw err;
    }
  },

  async removerPorFisio(usuario, fisioterapeutaId) {
    const pacienteId = toInt(usuario?.id);
    const fisioId = toInt(fisioterapeutaId);

    const r = await queryWithContext(
      usuario,
      (req) => req
        .input('PacienteId', sql.Int, pacienteId)
        .input('FisioterapeutaId', sql.Int, fisioId),
      `
      DELETE FROM dbo.Favoritos
      WHERE PacienteId = @PacienteId AND FisioterapeutaId = @FisioterapeutaId;
      `
    );

    return r.rowsAffected?.[0] || 0;
  }
};
