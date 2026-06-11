// 📁 services/_queryWithContext.js
import getPool, { sql } from '../config/dbConfig.js';

/**
 * Executa uma query garantindo SESSION_CONTEXT no MESMO batch/Request.
 * IMPORTANTE: usa somente UsuarioTipo e UsuarioId.
 *
 * UsuarioTipo deve ser sempre: 'Admin' | 'Paciente' | 'Fisioterapeuta'
 *
 * ⚠️ Pool:
 * - SESSION_CONTEXT é por conexão. Por isso setamos e limpamos dentro do MESMO batch.
 * - NÃO use @read_only=1 aqui, porque você precisa limpar e reaplicar a cada request.
 */

function normalizeUsuarioTipo(tipo) {
  const t = String(tipo || '').trim().toLowerCase();
  if (!t) return null;

  if (t === 'admin' || t === 'administrador') return 'Admin';
  if (t === 'paciente') return 'Paciente';
  if (t === 'fisioterapeuta' || t === 'fisio') return 'Fisioterapeuta';

  return null;
}

/** Garante int positivo para UsuarioId */
function toPositiveInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

/**
 * @param {object|null} usuario { id, tipo }
 * @param {(req: import('mssql').Request) => void} buildInputsFn
 * @param {string} sqlText
 * @param {object} [options]
 * @param {boolean} [options.clearContext=true] - limpa UsuarioTipo/UsuarioId ao final do batch
 * @param {boolean} [options.requireContext=false] - se true, falha se não houver contexto válido
 */
export async function queryWithContext(usuario, buildInputsFn, sqlText, options = {}) {
  const { clearContext = true, requireContext = false } = options;

  if (!sqlText || typeof sqlText !== 'string') {
    throw new Error('sqlText é obrigatório (string).');
  }

  const pool = await getPool();
  const request = pool.request();

  if (typeof buildInputsFn === 'function') buildInputsFn(request);

  const usuarioId = toPositiveInt(usuario?.id);
  const usuarioTipo = normalizeUsuarioTipo(usuario?.tipo);

  if (requireContext && (!usuarioId || !usuarioTipo)) {
    throw new Error('Usuário/Contexto inválido: UsuarioTipo/UsuarioId obrigatórios.');
  }

  // Sem contexto (ou inválido) => executa normal
  if (!usuarioId || !usuarioTipo) {
    return request.query(sqlText);
  }

  request.input('__CtxUsuarioId', sql.Int, usuarioId);
  request.input('__CtxUsuarioTipo', sql.NVarChar(30), usuarioTipo);

  const setCtx = `
    EXEC sys.sp_set_session_context @key=N'UsuarioTipo', @value=@__CtxUsuarioTipo;
    EXEC sys.sp_set_session_context @key=N'UsuarioId',   @value=@__CtxUsuarioId;
  `;

  const clearCtx = `
    EXEC sys.sp_set_session_context @key=N'UsuarioTipo', @value=NULL;
    EXEC sys.sp_set_session_context @key=N'UsuarioId',   @value=NULL;
  `;

  const wrapped = `
BEGIN TRY
  -- garante que não herdou nada da conexão do pool
  ${setCtx}

  ${sqlText}

  ${clearContext ? clearCtx : ''}
END TRY
BEGIN CATCH
  ${clearContext ? clearCtx : ''}
  ;THROW;
END CATCH
`;

  return request.query(wrapped);
}
