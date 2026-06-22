// 📁 controllers/recibosController.js
import recibosService from '../services/recibosService.js';
import fileStorageProvider from '../providers/fileStorageProvider.js';

function requireUsuario(req, res) {
  const u = req.usuario;
  if (!u?.id || !u?.tipo) {
    res.status(401).json({ sucesso: false, erro: 'Token ausente, inválido ou expirado.' });
    return null;
  }
  return u;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

export default {
  async listar(req, res) {
    const u = requireUsuario(req, res);
    if (!u) return;

    try {
      const itens = await recibosService.listar(u);
      return res.json({ sucesso: true, total: itens.length, itens });
    } catch (e) {
      const status = e?.httpStatus || 500;
      return res.status(status).json({ sucesso: false, erro: status >= 500 ? 'Erro interno do servidor.' : (e?.message || '') });
    }
  },

  async detalhar(req, res) {
    const u = requireUsuario(req, res);
    if (!u) return;

    try {
      const id = toInt(req.params?.id);
      if (!id) return res.status(400).json({ sucesso: false, erro: 'Id inválido.' });

      const item = await recibosService.detalhar(u, id);
      if (!item) return res.status(404).json({ sucesso: false, erro: 'Recibo não encontrado.' });

      return res.json({ sucesso: true, item });
    } catch (e) {
      const status = e?.httpStatus || 500;
      return res.status(status).json({ sucesso: false, erro: status >= 500 ? 'Erro interno do servidor.' : (e?.message || '') });
    }
  },

  async pdf(req, res) {
    const u = requireUsuario(req, res);
    if (!u) return;

    try {
      const id = toInt(req.params?.id);
      if (!id) return res.status(400).json({ sucesso: false, erro: 'Id inválido.' });

      const inline = String(req.query?.inline || '') === '1';

      const pdfInfo = await recibosService.obterPdf(u, id);
      const storagePath = pdfInfo?.storagePath || pdfInfo?.relPath;
      if (!storagePath) return res.status(404).json({ sucesso: false, erro: 'Recibo/PDF não encontrado.' });

      return fileStorageProvider.sendFile(res, storagePath, {
        disposition: inline ? 'inline' : 'attachment',
        fileName: pdfInfo.fileName,
        contentType: 'application/pdf',
        cacheControl: 'no-store',
        rangeHeader: req.headers.range,
      });
    } catch (e) {
      const status = e?.httpStatus || 500;
      return res.status(status).json({ sucesso: false, erro: status >= 500 ? 'Erro interno do servidor.' : (e?.message || '') });
    }
  }
};

