// 📁 services/notasFiscaisService.js
import fs from 'fs';
import path from 'path';
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

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

// ✅ Igual ao seu padrão de vídeos: uploadsBase + subpasta
const uploadsBase = path.resolve('uploads');                 // ex: ...\mvp-backend\uploads
const nfsDir = path.join(uploadsBase, 'NFs');                // ex: ...\mvp-backend\uploads\NFs

let nfsDirReadyPromise = null;
async function ensureNfsDir() {
  if (!nfsDirReadyPromise) {
    nfsDirReadyPromise = fs.promises.mkdir(nfsDir, { recursive: true });
  }
  await nfsDirReadyPromise;
}

function normalizeRel(p) {
  return String(p || '').replaceAll('\\', '/');
}

// Aceita:
// - "NFs/2025-11/NF-123.pdf" (relativo ao uploadsBase)
// - "2025-11/NF-123.pdf"     (relativo ao nfsDir)
async function resolveNfAbsolute(dbPath) {
  if (!dbPath) return null;
  const rel = normalizeRel(dbPath);

  const candidate = rel.toLowerCase().startsWith('nfs/')
    ? path.resolve(uploadsBase, rel)
    : path.resolve(nfsDir, rel);

  // 🔒 bloqueia path traversal e garante ficar *dentro* de uploads/NFs
  const base = path.resolve(nfsDir);
  const relToBase = path.relative(base, candidate);
  if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) return null;

  try {
    await fs.promises.access(candidate, fs.constants.F_OK);
  } catch {
    return null;
  }

  return candidate;
}

// ✅ Helper (admin/integração): salva PDF/XML no disco e devolve caminho relativo (para gravar no banco)
async function salvarArquivoNfEmDisco({ competencia, numeroNf, nfId, tipo, buffer, base64 }) {
  await ensureNfsDir();

  const ext = String(tipo || '').toLowerCase();
  if (!['pdf', 'xml'].includes(ext)) throw new HttpError(400, 'Tipo inválido. Use pdf ou xml.');

  const comp = String(competencia || 'sem-competencia').replace(/[^\d\-]/g, '') || 'sem-competencia';
  const pasta = path.join(nfsDir, comp);
  await fs.promises.mkdir(pasta, { recursive: true });

  const nomeBase = numeroNf ? `NF-${String(numeroNf)}` : `NF-${assertId(nfId, 'nfId')}`;
  const safeName = nomeBase.replace(/[^\w\-\.]/g, '_');

  const fullPath = path.join(pasta, `${safeName}.${ext}`);

  const fileBuffer = Buffer.isBuffer(buffer)
    ? buffer
    : Buffer.from(String(base64 || ''), 'base64');

  if (!fileBuffer?.length) throw new HttpError(400, 'Conteúdo do arquivo vazio.');

  await fs.promises.writeFile(fullPath, fileBuffer);

  // ✅ padrão igual vídeos: caminho relativo ao "uploads"
  return `NFs/${comp}/${safeName}.${ext}`;
}

const notasFiscaisService = {
  async listar(usuario, { fisioterapeutaId = null, status = null, competencia = null, page = 1, pageSize = 20 } = {}) {
    await ensureNfsDir();

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
    const caminho = ext === 'xml' ? nf.CaminhoXml : nf.CaminhoPdf;
    if (!caminho) return null;

    const absolute = await resolveNfAbsolute(caminho);
    if (!absolute) return null;

    const base = nf.NumeroNf ? `NF-${String(nf.NumeroNf)}` : `NF-${nf.Id}`;
    const safeBase = base.replace(/[^\w\-\.]/g, '_');

    return {
      fullPath: absolute,
      fileName: `${safeBase}.${ext === 'xml' ? 'xml' : 'pdf'}`
    };
  },

  salvarArquivoNfEmDisco
};
export default notasFiscaisService;
