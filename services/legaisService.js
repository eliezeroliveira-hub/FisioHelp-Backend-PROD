// 📁 services/legaisService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

function requireAuth(usuario) {
  if (!usuario?.id || !usuario?.tipo) throw new HttpError(401, 'Não autenticado.');
}

const TIPOS_VALIDOS = new Set(['Termos', 'Privacidade', 'CancelamentoReembolso']);

function normalizarTipoLegal(tipo) {
  const s = String(tipo ?? '').trim();
  if (!s) return null;

  const key = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s-]+/g, '_');

  const mapa = {
    termos: 'Termos',
    termo: 'Termos',
    termo_de_uso: 'Termos',
    termos_de_uso: 'Termos',
    privacidade: 'Privacidade',
    politica_de_privacidade: 'Privacidade',
    politica_privacidade: 'Privacidade',
    cancelamentoreembolso: 'CancelamentoReembolso',
    cancelamento_reembolso: 'CancelamentoReembolso',
    politica_de_cancelamento_reembolso: 'CancelamentoReembolso',
    politica_cancelamento_reembolso: 'CancelamentoReembolso',
    politica_de_cancelamento: 'CancelamentoReembolso',
    politica_cancelamento: 'CancelamentoReembolso',
    cancelamento: 'CancelamentoReembolso',
    reembolso: 'CancelamentoReembolso'
  };

  return mapa[key] || null;
}

function normalizarTiposFiltro(tipos) {
  if (!Array.isArray(tipos) || tipos.length === 0) return null;

  const normalizados = tipos
    .map((t) => normalizarTipoLegal(t))
    .filter(Boolean);

  if (normalizados.length !== tipos.length) {
    throw new HttpError(400, 'Tipo inválido. Use: Termos, Privacidade ou CancelamentoReembolso.');
  }

  const unicos = [...new Set(normalizados)];
  if (unicos.some((t) => !TIPOS_VALIDOS.has(t))) {
    throw new HttpError(400, 'Tipo inválido. Use: Termos, Privacidade ou CancelamentoReembolso.');
  }

  return unicos;
}

const legaisService = {
  async verificarPendencias(usuario) {
    requireAuth(usuario);

    const result = await queryWithContext(usuario, (req) => {
      req.input('UsuarioTipo', sql.NVarChar(40), String(usuario.tipo));
      req.input('UsuarioId', sql.Int, Number(usuario.id));
    }, `
      EXEC dbo.sp_VerificarPendenciasDocumentosLegais
        @UsuarioTipo = @UsuarioTipo,
        @UsuarioId   = @UsuarioId;
    `);

    return result?.recordset ?? [];
  },

  async listarAtivos(usuario, { tipos = null } = {}) {
    requireAuth(usuario);
    const tiposFiltro = normalizarTiposFiltro(tipos);

    // filtro simples (pra evitar construir IN dinâmico)
    let where = '';
    if (Array.isArray(tiposFiltro) && tiposFiltro.length > 0) {
      where = 'WHERE Tipo IN (' + tiposFiltro.map((_, i) => `@T${i}`).join(',') + ')';
    }

    const result = await queryWithContext(usuario, (req) => {
      if (Array.isArray(tiposFiltro) && tiposFiltro.length > 0) {
        tiposFiltro.forEach((t, i) => req.input(`T${i}`, sql.NVarChar(80), t));
      }
    }, `
      SELECT
        Id, Tipo, Versao, Titulo, Conteudo, PublicadoEm, AtualizadoEm
      FROM dbo.vw_DocumentosLegais_Ativos
      ${where}
      ORDER BY Tipo ASC, AtualizadoEm DESC;
    `);

    return result?.recordset ?? [];
  },

  async registrarAceite(usuario, { documentoLegalId, ip, userAgent, origem }) {
    requireAuth(usuario);

    const id = Number(documentoLegalId);
    if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, 'documentoLegalId inválido.');

    const result = await queryWithContext(usuario, (req) => {
      req.input('DocumentoLegalId', sql.Int, id);
      req.input('Ip', sql.NVarChar(60), ip || null);
      req.input('UserAgent', sql.NVarChar(1024), userAgent || null);
      req.input('Origem', sql.NVarChar(120), origem || 'App');
    }, `
      EXEC dbo.sp_RegistrarAceiteDocumentoLegal
        @DocumentoLegalId = @DocumentoLegalId,
        @Ip = @Ip,
        @UserAgent = @UserAgent,
        @Origem = @Origem;
    `);

    return result?.recordset ?? null;
  }
};

export { HttpError };
export default legaisService;
