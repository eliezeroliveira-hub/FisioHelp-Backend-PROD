// 📁 controllers/recibosController.js
import fs from 'fs';
import path from 'path';
import recibosService from '../services/recibosService.js';

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
      if (!pdfInfo?.absPath) return res.status(404).json({ sucesso: false, erro: 'Recibo/PDF não encontrado.' });

      const absPath = pdfInfo.absPath;
      const fileName = pdfInfo.fileName || path.basename(absPath);

      // Segurança: garante que arquivo existe
      try {
        await fs.promises.access(absPath, fs.constants.F_OK);
      } catch {
        return res.status(404).json({ sucesso: false, erro: 'Arquivo do recibo não encontrado.' });
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${fileName}"`);

      const stream = fs.createReadStream(absPath);
      stream.on('error', () => res.status(500).end());
      return stream.pipe(res);
    } catch (e) {
      const status = e?.httpStatus || 500;
      return res.status(status).json({ sucesso: false, erro: status >= 500 ? 'Erro interno do servidor.' : (e?.message || '') });
    }
  }
};

