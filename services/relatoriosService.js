// 📁 services/relatoriosService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

function asTipo(usuario) {
  return String(usuario?.tipo || '').toLowerCase();
}
function isAdmin(usuario) {
  return asTipo(usuario) === 'admin';
}
function isFisio(usuario) {
  return asTipo(usuario) === 'fisioterapeuta';
}

function requireUser(usuario) {
  if (!usuario?.id || !usuario?.tipo) throw new HttpError(401, 'Não autenticado.');
}

function assertId(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} inválido.`);
  return n;
}

const relatoriosService = {
  /**
   * Relatórios > Pontuação
   * Fonte: dbo.vw_FisioPontuacaoResumo
   */
  async pontuacao(usuario, opts = {}) {
    requireUser(usuario);

    // Fisio sempre enxerga somente o dele
    if (isFisio(usuario)) {
      const fid = assertId(usuario.id, 'UsuarioId');

      const result = await queryWithContext(usuario, (req) => {
        req.input('FisioterapeutaId', sql.Int, fid);
      }, `
        SELECT
          FisioterapeutaId,
          Nome,
          PontuacaoFinal AS Pontos,
          TotalConsultas AS TotalConsultasConcluidas
        FROM analytics.vw_CacheRankingFisioterapeutas_Fonte
        WHERE FisioterapeutaId = @FisioterapeutaId;
      `);

      return result.recordset?.[0] || null;
    }

    // Admin pode ver 1 fisio específico ou todos
    if (isAdmin(usuario)) {
      const fisioterapeutaId = opts?.fisioterapeutaId ? assertId(opts.fisioterapeutaId, 'FisioterapeutaId') : null;

      const result = await queryWithContext(usuario, (req) => {
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId ?? null);
      }, `
        SELECT
          FisioterapeutaId,
          Nome,
          PontuacaoFinal AS Pontos,
          TotalConsultas AS TotalConsultasConcluidas
        FROM analytics.vw_CacheRankingFisioterapeutas_Fonte
        WHERE (@FisioterapeutaId IS NULL OR FisioterapeutaId = @FisioterapeutaId)
        ORDER BY PontuacaoFinal DESC;
      `);

      return fisioterapeutaId ? (result.recordset?.[0] || null) : (result.recordset || []);
    }

    throw new HttpError(403, 'Acesso negado.');
  }
};
export default relatoriosService;
