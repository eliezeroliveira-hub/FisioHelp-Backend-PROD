// 📁 controllers/notasFiscaisController.js
import fs from 'fs';
import notasFiscaisService from '../services/notasFiscaisService.js';
import { HttpError } from '../utils/httpError.js';
import { log } from '../config/logger.js';

function handleError(res, erro) {
  const status =
    (erro instanceof HttpError && erro.statusCode) ||
    erro?.statusCode ||
    erro?.codigo ||
    500;

  return res.status(status).json({
    sucesso: false,
    erro: status >= 500 ? 'Erro interno do servidor.' : (erro?.message || 'Erro interno.'),
    detalhes: erro?.details ?? erro?.detalhes ?? undefined
  });
}

function requireUsuario(req, res) {
  const usuario = req.usuario;
  if (!usuario?.id || !usuario?.tipo) {
    res.status(401).json({ sucesso: false, erro: 'Token ausente, inválido ou expirado.' });
    return null;
  }
  return usuario;
}

function asTipo(u) { return String(u?.tipo || '').toLowerCase(); }
function isAdmin(u) { return asTipo(u) === 'admin'; }

// ✅ Stream com Range (ótimo pra PDF grande)
async function streamFileWithRange(req, res, absoluteFilePath, { mime, fileName, inline }) {
  const stat = await fs.promises.stat(absoluteFilePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader('Content-Type', mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${fileName}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  // HEAD: só headers
  if (req.method === 'HEAD' && !range) {
    res.setHeader('Content-Length', fileSize);
    return res.status(200).end();
  }

  if (range) {
    // ex: "bytes=0-1023" ou "bytes=0-"
    const parts = String(range).replace(/bytes=/, '').split('-');
    const start = Number.parseInt(parts[0], 10);
    const rawEnd = parts[1] ? Number.parseInt(parts[1], 10) : fileSize - 1;

    const end = Number.isFinite(rawEnd) ? Math.min(rawEnd, fileSize - 1) : fileSize - 1;

    if (!Number.isFinite(start) || start < 0 || start >= fileSize || !Number.isFinite(end) || end < start) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end('Range inválido');
    }

    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkSize);

    if (req.method === 'HEAD') return res.end();

    return fs.createReadStream(absoluteFilePath, { start, end }).pipe(res);
  }

  res.setHeader('Content-Length', fileSize);
  return fs.createReadStream(absoluteFilePath).pipe(res);
}

const notasFiscaisController = {
  /**
   * GET /carteira/notas-fiscais
   */
  async listar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const fisioterapeutaId = isAdmin(usuario) ? (req.query.fisioterapeutaId ?? null) : null;

      const data = await notasFiscaisService.listar(usuario, {
        fisioterapeutaId,
        status: req.query.status ?? null,
        competencia: req.query.competencia ?? null,
        tipoReferencia: req.query.tipoReferencia ?? null,
        page: req.query.page ?? 1,
        pageSize: req.query.pageSize ?? 20
      });

      log('info', '🧾 Carteira > Notas fiscais (listar)', {
        fonte: 'dbo.vw_NotasFiscaisFisioterapeutas_App',
        userId: usuario.id,
        tipo: usuario.tipo,
        alvo: fisioterapeutaId ? Number(fisioterapeutaId) : Number(usuario.id),
        filtros: {
          status: req.query.status ?? null,
          competencia: req.query.competencia ?? null,
          tipoReferencia: req.query.tipoReferencia ?? null
        },
        total: data.total
      });

      return res.json({ sucesso: true, ...data });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /carteira/notas-fiscais/:id
   */
  async detalhar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const fisioterapeutaId = isAdmin(usuario) ? (req.query.fisioterapeutaId ?? null) : null;

      const nf = await notasFiscaisService.buscarPorId(usuario, req.params.id, {
        fisioterapeutaId
      });

      log('info', '🧾 Carteira > Notas fiscais (detalhar)', {
        fonte: 'dbo.vw_NotasFiscaisFisioterapeutas_App',
        userId: usuario.id,
        tipo: usuario.tipo,
        alvo: fisioterapeutaId ? Number(fisioterapeutaId) : Number(usuario.id),
        nfId: Number(req.params.id),
        encontrou: !!nf
      });

      if (!nf) return res.status(404).json({ sucesso: false, erro: 'NF não encontrada.' });
      return res.json({ sucesso: true, nf });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /carteira/notas-fiscais/:id/pdf?inline=1
   * - suporta Range para PDF grande
   */
  async downloadPdf(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const inline = String(req.query.inline ?? '0') === '1';
      const fisioterapeutaId = isAdmin(usuario) ? (req.query.fisioterapeutaId ?? null) : null;

      const arq = await notasFiscaisService.obterArquivo(usuario, req.params.id, 'pdf', {
        fisioterapeutaId
      });

      if (!arq?.fullPath) {
        return res.status(404).json({
          sucesso: false,
          erro: 'PDF não disponível para esta NF (provavelmente ainda não emitida).'
        });
      }

      try {
        await fs.promises.access(arq.fullPath, fs.constants.F_OK);
      } catch {
        return res.status(404).json({
          sucesso: false,
          erro: 'Arquivo PDF não encontrado no servidor.'
        });
      }

      // fallback caso o service não envie mime
      const mime = arq.mime || 'application/pdf';

      return await streamFileWithRange(req, res, arq.fullPath, {
        mime,
        fileName: arq.fileName || `NF-${req.params.id}.pdf`,
        inline
      });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /carteira/notas-fiscais/:id/xml?inline=1
   * (XML costuma ser pequeno; sendFile ok)
   */
  async downloadXml(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const inline = String(req.query.inline ?? '0') === '1';
      const fisioterapeutaId = isAdmin(usuario) ? (req.query.fisioterapeutaId ?? null) : null;

      const arq = await notasFiscaisService.obterArquivo(usuario, req.params.id, 'xml', {
        fisioterapeutaId
      });

      if (!arq) {
        return res.status(404).json({
          sucesso: false,
          erro: 'XML não disponível para esta NF (provavelmente ainda não emitida).'
        });
      }

      res.setHeader('Content-Type', arq.mime || 'application/xml');
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${arq.fileName}"`);
      return res.sendFile(arq.fullPath);
    } catch (erro) {
      return handleError(res, erro);
    }
  }
};

export default notasFiscaisController;

