// 📁 controllers/videosController.js
import fs from 'fs';
import path from 'path';
import videosService from '../services/videosService.js';

const uploadsBase = path.resolve('uploads');

function parsePositiveIntOrNull(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseNonNegativeIntOrNull(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function getVideoMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  return 'application/octet-stream';
}

async function streamVideoInline(req, res, absoluteFilePath) {
  const stat = await fs.promises.stat(absoluteFilePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader('Content-Type', getVideoMimeType(absoluteFilePath));
  res.setHeader('Content-Disposition', 'inline'); // ✅ não força download
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  // Suporte a Range (necessário para player <video>)
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      return res.status(416).send('Range inválido');
    }

    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkSize);

    return fs.createReadStream(absoluteFilePath, { start, end }).pipe(res);
  }

  res.setHeader('Content-Length', fileSize);
  return fs.createReadStream(absoluteFilePath).pipe(res);
}

const videosController = {
  /**
   * POST /videos/me/video-bruto
   * Form-data: video=<arquivo>
   */
  async uploadVideoBruto(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT

      if (!usuario?.id || !usuario?.tipo) {
        return res.status(401).json({ sucesso: false, mensagem: 'Não autenticado.' });
      }

      if (!req.file) {
        return res.status(400).json({ sucesso: false, mensagem: 'Arquivo de vídeo é obrigatório.' });
      }

      const caminhoRelativo = `videos_brutos/${req.file.filename}`;

      const registro = await videosService.registrarVideoBruto(usuario, {
        fisioterapeutaId: Number(usuario.id),
        caminhoRelativo
      });

      return res.status(201).json({
        sucesso: true,
        mensagem: 'Vídeo bruto enviado e registrado com sucesso.',
        documento: registro
      });
    } catch (err) {
      const status = Number(err?.httpStatus || err?.statusCode) || 500;
      return res.status(status).json({
        sucesso: false,
        mensagem: 'Erro ao enviar vídeo bruto.',
        erro: status >= 500 ? 'Erro interno do servidor.' : err.message
      });
    }
  },

  /**
   * GET /videos/me/video-bruto
   */
  async listarMeusVideosBrutos(req, res) {
  try {
    const usuario = req.usuario; // { id, tipo } vindo do JWT

    if (!usuario?.id || !usuario?.tipo) {
      return res.status(401).json({ sucesso: false, mensagem: 'Não autenticado.' });
    }

    const limit = parsePositiveIntOrNull(req.query?.limit);
    const offset = parseNonNegativeIntOrNull(req.query?.offset);
    const resultado = await videosService.listarMeusVideosBrutos(usuario, { limit, offset });
    const itensBrutos = resultado?.itens || [];

    // 🔒 Remove ValidadorId da resposta para o fisioterapeuta
    const itens = itensBrutos.map(({ ValidadorId, validadorId, ...resto }) => resto);

    return res.json({
      sucesso: true,
      total: itens.length,
      totalRegistros: Number(resultado?.totalRegistros ?? itens.length),
      totalNaPagina: Number(resultado?.totalNaPagina ?? itens.length),
      limit: Number(resultado?.limit ?? 20),
      offset: Number(resultado?.offset ?? 0),
      itens
    });
  } catch (err) {
    return res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao listar vídeos brutos.',
      erro: 'Erro interno do servidor.'
    });
  }
},

  /**
   * GET /videos/me/video-bruto/:documentoId/visualizar
   * Stream inline (sem endpoint de download para fisioterapeuta)
   */
  async visualizarMeuVideoBruto(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT

      if (!usuario?.id || !usuario?.tipo) {
        return res.status(401).json({ sucesso: false, mensagem: 'Não autenticado.' });
      }

      const documentoId = Number(req.params.documentoId);
      if (!Number.isFinite(documentoId) || documentoId <= 0) {
        return res.status(400).json({ sucesso: false, mensagem: 'documentoId inválido.' });
      }

      // Busca garantindo ownership (somente do próprio fisio)
      const doc = await videosService.buscarMeuVideoBrutoPorId(usuario, documentoId);
      if (!doc) {
        return res.status(404).json({ sucesso: false, mensagem: 'Vídeo não encontrado.' });
      }

      // Normaliza e monta caminho absoluto seguro
      const relative = String(doc.CaminhoArquivo || '').replaceAll('\\', '/'); // ex: videos_brutos/arquivo.mp4
      const absolute = path.resolve(uploadsBase, relative);

      // Proteção contra path traversal
      if (!absolute.startsWith(uploadsBase)) {
        return res.status(400).json({ sucesso: false, mensagem: 'Caminho inválido.' });
      }

      try {
        await fs.promises.access(absolute, fs.constants.F_OK);
      } catch {
        return res.status(404).json({ sucesso: false, mensagem: 'Arquivo não existe no servidor.' });
      }

      return await streamVideoInline(req, res, absolute);
    } catch (err) {
      return res.status(500).json({
        sucesso: false,
        mensagem: 'Erro ao visualizar vídeo bruto.',
        erro: 'Erro interno do servidor.'
      });
    }
  }
};

export default videosController;


