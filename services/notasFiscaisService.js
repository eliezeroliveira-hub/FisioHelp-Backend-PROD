// 📁 services/notasFiscaisService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';
import fileStorageProvider from '../providers/fileStorageProvider.js';

function asTipo(u) { return String(u?.tipo || '').toLowerCase(); }
function isAdmin(u) { return asTipo(u) === 'admin'; }
function isFisio(u) { return asTipo(u) === 'fisioterapeuta'; }
function requireAuth(usuario) {
  if (!usuario?.id || !usuario?.tipo) throw new HttpError(401, 'Não autenticado.');
}
function assertId(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} inválido.`);
  return n;
}

function normalizeRel(p) {
  return String(p || '').replaceAll('\\', '/');
}

// Aceita:
// - "NFs/2025-11/NF-123.pdf" (relativo ao uploadsBase)
// - "2025-11/NF-123.pdf"     (relativo ao diretório lógico NFs)
function resolveNfStoragePath(dbPath) {
  if (!dbPath) return null;

  const rel = normalizeRel(dbPath);
  const storagePath = fileStorageProvider.normalizeStoragePath(
    rel.toLowerCase().startsWith('nfs/') ? rel : `NFs/${rel}`
  );

  if (!storagePath.toLowerCase().startsWith('nfs/')) return null;
  return storagePath;
}

function mimeFromExt(ext) {
  return ext === 'xml' ? 'application/xml' : 'application/pdf';
}

// Helper (admin/integração): salva PDF/XML no provider configurado e devolve caminho relativo para gravar no banco.
// O nome histórico foi mantido para não quebrar chamadas existentes.
async function salvarArquivoNfEmDisco({ competencia, numeroNf, nfId, tipo, buffer, base64 }) {
  const ext = String(tipo || '').toLowerCase();
  if (!['pdf', 'xml'].includes(ext)) throw new HttpError(400, 'Tipo inválido. Use pdf ou xml.');

  const comp = String(competencia || 'sem-competencia').replace(/[^\d\-]/g, '') || 'sem-competencia';
  const nomeBase = numeroNf ? `NF-${String(numeroNf)}` : `NF-${assertId(nfId, 'nfId')}`;
  const safeName = nomeBase.replace(/[^\w\-\.]/g, '_');
  const relativePath = `NFs/${comp}/${safeName}.${ext}`;

  const fileBuffer = Buffer.isBuffer(buffer)
    ? buffer
    : Buffer.from(String(base64 || ''), 'base64');

  if (!fileBuffer?.length) throw new HttpError(400, 'Conteúdo do arquivo vazio.');

  await fileStorageProvider.uploadBuffer(relativePath, fileBuffer, {
    contentType: mimeFromExt(ext),
    cacheControl: 'no-store'
  });

  return relativePath;
}

const notasFiscaisService = {
  async listar(usuario, { fisioterapeutaId = null, status = null, competencia = null, page = 1, pageSize = 20 } = {}) {
    requireAuth(usuario);
    if (!isAdmin(usuario) && !isFisio(usuario)) throw new HttpError(403, 'Acesso negado.');

    const fid = isFisio(usuario)
      ? assertId(usuario.id, 'Usuário')
      : assertId(fisioterapeutaId ?? usuario.id, 'FisioterapeutaId');

    const pg = Math.max(1, Math.floor(Number(page) || 1));
    const ps = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 20)));
    const offset = (pg - 1) * ps;

    const result = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fid);
      req.input('Status', sql.NVarChar(40), status || null);
      req.input('Competencia', sql.Char(7), competencia || null);
      req.input('Offset', sql.Int, offset);
      req.input('PageSize', sql.Int, ps);
    }, `
      -- ⚠️ IMPORTANTE: CTE (WITH Base AS ...) só existe dentro de UMA instrução.
      -- Antes, o COUNT e o SELECT paginado eram duas instruções diferentes usando a mesma CTE,
      -- e isso causava: "Invalid object name 'Base'".
      ;WITH Base AS (
        SELECT *
        FROM dbo.vw_NotasFiscaisFisioterapeutas_App
        WHERE FisioterapeutaId = @FisioterapeutaId
          AND (@Status IS NULL OR Status = @Status)
          AND (@Competencia IS NULL OR Competencia = @Competencia)
      )
      SELECT COUNT(1) AS Total FROM Base;

      ;WITH Base AS (
        SELECT *
        FROM dbo.vw_NotasFiscaisFisioterapeutas_App
        WHERE FisioterapeutaId = @FisioterapeutaId
          AND (@Status IS NULL OR Status = @Status)
          AND (@Competencia IS NULL OR Competencia = @Competencia)
      )
      SELECT *
      FROM Base
      ORDER BY CriadoEm DESC, Id DESC
      OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY;
    `);

    return {
      total: result.recordsets?.[0]?.[0]?.Total ?? 0,
      itens: result.recordsets?.[1] ?? [],
      page: pg,
      pageSize: ps
    };
  },

  async buscarPorId(usuario, nfId, { fisioterapeutaId = null } = {}) {
    requireAuth(usuario);
    if (!isAdmin(usuario) && !isFisio(usuario)) throw new HttpError(403, 'Acesso negado.');

    const id = assertId(nfId, 'Id');

    const fid = isFisio(usuario)
      ? assertId(usuario.id, 'Usuário')
      : assertId(fisioterapeutaId ?? usuario.id, 'FisioterapeutaId');

    const result = await queryWithContext(usuario, (req) => {
      req.input('Id', sql.Int, id);
      req.input('FisioterapeutaId', sql.Int, fid);
    }, `
      SELECT TOP 1 *
      FROM dbo.vw_NotasFiscaisFisioterapeutas_App
      WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;
    `);

    return result.recordset?.[0] || null;
  },

  async obterArquivo(usuario, nfId, tipo, { fisioterapeutaId = null } = {}) {
    const nf = await this.buscarPorId(usuario, nfId, { fisioterapeutaId });
    if (!nf) return null;

    const ext = String(tipo || '').toLowerCase();
    if (!['pdf', 'xml'].includes(ext)) throw new HttpError(400, 'Tipo inválido. Use pdf ou xml.');

    const caminho = ext === 'xml' ? nf.CaminhoXml : nf.CaminhoPdf;
    if (!caminho) return null;

    const storagePath = resolveNfStoragePath(caminho);
    if (!storagePath) return null;

    const exists = await fileStorageProvider.fileExists(storagePath);
    if (!exists) return null;

    const base = nf.NumeroNf ? `NF-${String(nf.NumeroNf)}` : `NF-${nf.Id}`;
    const safeBase = base.replace(/[^\w\-\.]/g, '_');

    return {
      storagePath,
      mime: mimeFromExt(ext),
      fileName: `${safeBase}.${ext === 'xml' ? 'xml' : 'pdf'}`
    };
  },

  salvarArquivoNfEmDisco
};
export default notasFiscaisService;