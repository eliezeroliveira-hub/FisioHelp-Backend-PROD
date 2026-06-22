// 📁 controllers/videosController.js
import path from 'path';
import videosService from '../services/videosService.js';
import fileStorageProvider from '../providers/fileStorageProvider.js';


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
      let arquivoSubido = false;

      await fileStorageProvider.uploadFile(caminhoRelativo, req.file.path, {
        contentType: req.file.mimetype,
        cacheControl: 'no-store',
      });
      arquivoSubido = true;

      let registro;
      try {
        registro = await videosService.registrarVideoBruto(usuario, {
          fisioterapeutaId: Number(usuario.id),
          caminhoRelativo
        });
      } catch (err) {
        if (arquivoSubido) await fileStorageProvider.deleteFile(caminhoRelativo).catch(() => {});
        throw err;
      } finally {
        if (fileStorageProvider.isAzureBlobStorageEnabled) {
          await fileStorageProvider.cleanupLocalTempFile(req.file.path);
        }
      }

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

      let relative;
      try {
        relative = fileStorageProvider.normalizeStoragePath(doc.CaminhoArquivo || '');
      } catch {
        return res.status(400).json({ sucesso: false, mensagem: 'Caminho inválido.' });
      }

      if (!relative.startsWith('videos_brutos/')) {
        return res.status(400).json({ sucesso: false, mensagem: 'Caminho inválido.' });
      }

      if (!await fileStorageProvider.fileExists(relative)) {
        return res.status(404).json({ sucesso: false, mensagem: 'Arquivo não existe no servidor.' });
      }

      return fileStorageProvider.sendFile(res, relative, {
        disposition: 'inline',
        fileName: path.basename(relative),
        contentType: getVideoMimeType(relative),
        cacheControl: 'no-store',
        rangeHeader: req.headers.range,
      });
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


