// 📁 controllers/notasFiscaisController.js
import notasFiscaisService from '../services/notasFiscaisService.js';
import fileStorageProvider from '../providers/fileStorageProvider.js';
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

      if (!arq?.storagePath) {
        return res.status(404).json({
          sucesso: false,
          erro: 'PDF não disponível para esta NF (provavelmente ainda não emitida).'
        });
      }

      return await fileStorageProvider.sendFile(res, arq.storagePath, {
        disposition: inline ? 'inline' : 'attachment',
        contentType: arq.mime || 'application/pdf',
        fileName: arq.fileName || `NF-${req.params.id}.pdf`,
        cacheControl: 'no-store',
        rangeHeader: req.headers.range
      });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /carteira/notas-fiscais/:id/xml?inline=1
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

      if (!arq?.storagePath) {
        return res.status(404).json({
          sucesso: false,
          erro: 'XML não disponível para esta NF (provavelmente ainda não emitida).'
        });
      }

      return await fileStorageProvider.sendFile(res, arq.storagePath, {
        disposition: inline ? 'inline' : 'attachment',
        contentType: arq.mime || 'application/xml',
        fileName: arq.fileName || `NF-${req.params.id}.xml`,
        cacheControl: 'no-store'
      });
    } catch (erro) {
      return handleError(res, erro);
    }
  }
};

export default notasFiscaisController;