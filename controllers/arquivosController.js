// 📁 controllers/arquivosController.js
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import { sql } from '../config/dbConfig.js';
import { ENV } from '../config/env.js';
import { queryWithContext } from '../services/_queryWithContext.js';
import chatService from '../services/chatService.js';
import pacientesService from '../services/pacientesService.js';
import fileStorageProvider from '../providers/fileStorageProvider.js';
import { ensureHeicPreview, isHeicStoragePath } from '../utils/heicPreview.js';

const uploadsBase = path.resolve('uploads');
const certificadosBase = path.resolve(uploadsBase, 'certificados');
const thumbsBase = path.resolve(certificadosBase, '_thumbs');

function contextoSistema() {
  return { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
}

function normalizarRelPath(p) {
  return String(p || '').trim().replace(/\\/g, '/');
}

/**
 * Converte o caminho salvo no banco (que pode ser absoluto no Windows)
 * para um caminho RELATIVO dentro de uploads/, no padrão:
 *   certificados/<arquivo>.pdf
 */
function normalizarRelCertificadoFromDb(caminhoArquivo) {
  const p = normalizarRelPath(caminhoArquivo);
  if (!p) throw new Error('Caminho do arquivo não informado.');

  const lower = p.toLowerCase();

  // Já está relativo
  if (lower.startsWith('certificados/')) return p;

  // "uploads/certificados/..."
  if (lower.startsWith('uploads/certificados/')) {
    return p.substring('uploads/'.length);
  }

  // ".../uploads/certificados/..."
  const marker = '/uploads/certificados/';
  const idx = lower.lastIndexOf(marker);
  if (idx !== -1) {
    // retorna "certificados/..."
    return p.substring(idx + '/uploads/'.length);
  }

  // Qualquer ".../certificados/..." (ex.: C:/.../certificados/arquivo.pdf)
  const idx2 = lower.lastIndexOf('certificados/');
  if (idx2 !== -1) {
    return p.substring(idx2);
  }

  throw new Error('Caminho inválido.');
}

function validarRelCertificado(rel) {
  if (!rel.startsWith('certificados/')) {
    throw new Error('Caminho inválido.');
  }

  // Bloqueia traversal dentro de uploads (ex.: certificados/../outros)
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((seg) => seg === '..' || seg.includes('..'))) {
    throw new Error('Path traversal bloqueado.');
  }
}

function normalizarRelPedidoMedicoFromDb(caminhoArquivo) {
  const p = normalizarRelPath(caminhoArquivo);
  if (!p) throw new Error('Caminho do arquivo não informado.');

  const lower = p.toLowerCase();

  if (lower.startsWith('pedidos-medicos/')) return p;

  if (lower.startsWith('uploads/pedidos-medicos/')) {
    return p.substring('uploads/'.length);
  }

  const marker = '/uploads/pedidos-medicos/';
  const idx = lower.lastIndexOf(marker);
  if (idx !== -1) {
    return p.substring(idx + '/uploads/'.length);
  }

  const idx2 = lower.lastIndexOf('pedidos-medicos/');
  if (idx2 !== -1) {
    return p.substring(idx2);
  }

  throw new Error('Caminho inválido.');
}

function validarRelPedidoMedico(rel) {
  if (!rel.startsWith('pedidos-medicos/')) {
    throw new Error('Caminho inválido.');
  }

  const parts = rel.split('/').filter(Boolean);
  if (parts.some((seg) => seg === '..' || seg.includes('..'))) {
    throw new Error('Path traversal bloqueado.');
  }
}

function getUsuarioInfo(usuario) {
  const tipo = String(usuario?.tipo ?? usuario?.usuarioTipo ?? '').trim();
  const tipoLower = tipo.toLowerCase();
  const id = Number(usuario?.id ?? usuario?.usuarioId ?? usuario?.userId);
  return { tipo, tipoLower, id };
}


function omitEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out;
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolverCertificadoPublicoOuAutorizado(usuario, formacaoId) {
  const { tipoLower, id: usuarioId } = getUsuarioInfo(usuario);
  const id = Number(formacaoId);

  if (!Number.isFinite(id) || id <= 0) {
    throw Object.assign(new Error('formacaoId inválido.'), { statusCode: 400 });
  }

  const result = await queryWithContext(
    contextoSistema(),
    (r) => {
      r.input('Id', sql.Int, id);
    },
    `
      SELECT
        ff.Id,
        ff.FisioterapeutaId,
        ff.CaminhoArquivo,
        fmp.Ativo,
        fmp.CrefitoVerificado,
        fmp.IsBloqueado
      FROM dbo.FormacoesFisioterapeutas ff
      LEFT JOIN dbo.FisioterapeutasMetricasPublicas fmp
        ON fmp.FisioterapeutaId = ff.FisioterapeutaId
      WHERE ff.Id = @Id;
    `
  );

  const row = result.recordset?.[0];
  if (!row) {
    throw Object.assign(new Error('Certificado não encontrado.'), { statusCode: 404 });
  }

  if (tipoLower === 'admin') return row;

  if (tipoLower === 'fisioterapeuta') {
    if (!Number.isFinite(usuarioId) || usuarioId <= 0) {
      throw Object.assign(new Error('Usuário inválido no token.'), { statusCode: 401 });
    }
    if (Number(row.FisioterapeutaId) === Number(usuarioId)) {
      return row;
    }
  }

  const publico =
    Number(row.Ativo) === 1 &&
    Number(row.CrefitoVerificado) === 1 &&
    Number(row.IsBloqueado) === 0;

  if (!publico) {
    throw Object.assign(new Error('Acesso negado a este certificado.'), { statusCode: 403 });
  }

  return row;
}

async function resolverPedidoMedicoAutorizado(usuario, documentoPacienteId) {
  const { tipoLower, id: usuarioId } = getUsuarioInfo(usuario);
  const docId = Number(documentoPacienteId);

  if (!Number.isFinite(docId) || docId <= 0) {
    throw Object.assign(new Error('documentoPacienteId inválido.'), { statusCode: 400 });
  }

  if (!Number.isFinite(usuarioId) || usuarioId <= 0) {
    throw Object.assign(new Error('Usuário inválido no token.'), { statusCode: 401 });
  }

  const result = await queryWithContext(
    usuario,
    (r) => {
      r.input('Id', sql.Int, docId);
    },
    `
      SELECT TOP 1
        dp.Id,
        dp.PacienteId,
        dp.CaminhoArquivo,
        dp.ConsultaId,
        dp.TipoDocumento,
        c.FisioterapeutaId
      FROM dbo.DocumentosPacientes dp
      LEFT JOIN dbo.Consultas c ON c.Id = dp.ConsultaId
      WHERE dp.Id = @Id
        AND dp.TipoDocumento = N'AutorizacaoAtendimento';
    `
  );

  const row = result.recordset?.[0];
  if (!row) {
    throw Object.assign(new Error('Pedido médico não encontrado.'), { statusCode: 404 });
  }

  const pacienteEhDono =
    tipoLower === 'paciente' && Number(row.PacienteId) === Number(usuarioId);
  const fisioDaConsulta =
    tipoLower === 'fisioterapeuta' &&
    Number(row.ConsultaId) > 0 &&
    Number(row.FisioterapeutaId) === Number(usuarioId);

  if (!pacienteEhDono && !fisioDaConsulta) {
    throw Object.assign(new Error('Acesso negado a este pedido médico.'), { statusCode: 403 });
  }

  const rel = normalizarRelPedidoMedicoFromDb(row.CaminhoArquivo);
  validarRelPedidoMedico(rel);

  if (!await fileStorageProvider.fileExists(rel)) {
    throw Object.assign(new Error('Arquivo não existe no servidor.'), { statusCode: 404 });
  }

  return {
    documentoPacienteId: row.Id,
    consultaId: row.ConsultaId,
    pacienteId: row.PacienteId,
    fisioterapeutaId: row.FisioterapeutaId,
    caminhoArquivo: rel,
    nomeArquivo: path.basename(rel),
  };
}

// Geração de thumbnail para PDF (usando magick OU pdftoppm)
async function gerarThumbPdf({ pdfPath, thumbPath }) {
  await fs.promises.mkdir(path.dirname(thumbPath), { recursive: true });

  const tryMagick = () =>
    new Promise((resolve, reject) => {
      const firstPage = `${pdfPath}[0]`;
      const args = ['-density', '160', firstPage, '-quality', '85', '-resize', '480x', thumbPath];

      const p = spawn('magick', args, { windowsHide: true });

      let stderr = '';
      p.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      p.on('error', reject);
      p.on('close', async (code) => {
        if (code === 0 && await fileExists(thumbPath)) return resolve();
        return reject(new Error(`magick falhou (code=${code}): ${stderr}`));
      });
    });

  const tryPdftoppm = () =>
    new Promise((resolve, reject) => {
      const outBase = thumbPath.replace(/\.png$/i, '');
      const args = ['-png', '-f', '1', '-singlefile', '-scale-to-x', '480', '-scale-to-y', '-1', pdfPath, outBase];

      const p = spawn('pdftoppm', args, { windowsHide: true });

      let stderr = '';
      p.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      p.on('error', reject);
      p.on('close', async (code) => {
        const outPng = `${outBase}.png`;
        if (code === 0 && await fileExists(outPng)) {
          if (outPng !== thumbPath) fs.renameSync(outPng, thumbPath);
          return resolve();
        }
        return reject(new Error(`pdftoppm falhou (code=${code}): ${stderr}`));
      });
    });

  try {
    await tryMagick();
  } catch (_) {
    await tryPdftoppm();
  }
}

const arquivosController = {
  /**
   * ✅ DOWNLOAD (Admin apenas, pois a rota foi restringida)
   * GET /arquivos/certificados/:formacaoId/download
   */
  async downloadCertificado(req, res) {
    try {
      const usuario = req.usuario;
      const { tipoLower, id: usuarioId } = getUsuarioInfo(usuario);

      const formacaoId = Number(req.params.formacaoId);
      if (!Number.isFinite(formacaoId) || formacaoId <= 0) {
        return res.status(400).json({ sucesso: false, erro: 'formacaoId inválido.' });
      }

      const result = await queryWithContext(
        usuario,
        (r) => {
          r.input('Id', sql.Int, formacaoId);
        },
        `
          SELECT Id, FisioterapeutaId, CaminhoArquivo
          FROM dbo.FormacoesFisioterapeutas
          WHERE Id = @Id;
        `
      );

      const row = result.recordset?.[0];
      if (!row) {
        return res.status(404).json({ sucesso: false, erro: 'Certificado não encontrado.' });
      }

      // ✅ Checagem de dono (se fisio), mesmo sendo rota admin-only hoje
      if (tipoLower === 'fisioterapeuta') {
        if (!Number.isFinite(usuarioId) || usuarioId <= 0) {
          return res.status(401).json({ sucesso: false, erro: 'Usuário inválido no token.' });
        }
        if (Number(row.FisioterapeutaId) !== Number(usuarioId)) {
          return res.status(403).json({ sucesso: false, erro: 'Acesso negado a este certificado.' });
        }
      }

      let rel;
      try {
        rel = normalizarRelCertificadoFromDb(row.CaminhoArquivo);
        validarRelCertificado(rel);
      } catch (e) {
        return res.status(400).json({ sucesso: false, erro: e.message });
      }

      // ✅ força download
      return fileStorageProvider.sendFile(res, rel, {
        disposition: 'attachment',
        fileName: path.basename(rel),
        cacheControl: 'no-store',
        rangeHeader: req.headers.range,
      });
    } catch (err) {
      return res.status(500).json({
        sucesso: false,
        erro: 'Erro ao baixar certificado.',
        detalhe: 'Erro interno do servidor.'
      });
    }
  },

  /**
   * ✅ VISUALIZAR (inline) — Fisio e Admin
   * GET /arquivos/certificados/:formacaoId/visualizar
   *
   * Observação: não existe "impedir download" 100%,
   * mas aqui não forçamos attachment e não oferecemos endpoint de download para fisio.
   */
  async visualizarCertificado(req, res) {
    try {
      const row = await resolverCertificadoPublicoOuAutorizado(req.usuario, req.params.formacaoId);

      let rel;
      try {
        rel = normalizarRelCertificadoFromDb(row.CaminhoArquivo);
        validarRelCertificado(rel);
      } catch (e) {
        return res.status(400).json({ sucesso: false, erro: e.message });
      }
      if (isHeicStoragePath(rel)) {
        const previewRel = await ensureHeicPreview({ sourceRelativePath: rel });
        if (!previewRel) {
          return res.status(404).json({
            sucesso: false,
            erro: 'Visualização indisponível para este arquivo HEIC.'
          });
        }

        return fileStorageProvider.sendFile(res, previewRel, {
          disposition: 'inline',
          fileName: path.basename(previewRel),
          contentType: 'image/jpeg',
          cacheControl: 'no-store',
          rangeHeader: req.headers.range,
        });
      }

      // ✅ inline (não força download)
      return fileStorageProvider.sendFile(res, rel, {
        disposition: 'inline',
        fileName: path.basename(rel),
        cacheControl: 'no-store',
        rangeHeader: req.headers.range,
      });
    } catch (err) {
      const status = err?.statusCode || err?.status || 500;
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro ao visualizar certificado.' : (err?.message || 'Erro ao visualizar certificado.'),
        detalhe: status >= 500 ? 'Erro interno do servidor.' : undefined
      });
    }
  }
  ,

  /**
   * ✅ DETALHES (JSON) — Fisio e Admin
   * GET /arquivos/certificados/:formacaoId/detalhes
   *
   * Usa dbo.vw_FormacoesFisioterapeutas e retorna somente campos preenchidos,
   * além de Media (URL do PDF inline).
   */
  async detalhesCertificado(req, res) {
    try {
      const usuario = req.usuario;
      const { tipoLower, id: usuarioId } = getUsuarioInfo(usuario);

      const formacaoId = Number(req.params.formacaoId);
      if (!Number.isFinite(formacaoId) || formacaoId <= 0) {
        return res.status(400).json({ sucesso: false, erro: 'formacaoId inválido.' });
      }

      const result = await queryWithContext(
        usuario,
        (r) => {
          r.input('Id', sql.Int, formacaoId);
        },
        `
          SELECT
            Id,
            FisioterapeutaId,
            Curso,
            Instituicao,
            MesInicio,
            AnoInicio,
            MesFim,
            AnoFim,
            AnoConclusao,
            TipoFormacao,
            Descricao,
            IdCredencial,
            UrlCredencial,
            Media
          FROM dbo.vw_FormacoesFisioterapeutas
          WHERE Id = @Id;
        `
      );

      const row = result.recordset?.[0];
      if (!row) {
        return res.status(404).json({ sucesso: false, erro: 'Certificado não encontrado.' });
      }

      // ✅ Checagem de dono (fisioterapeuta só vê o próprio certificado)
      if (tipoLower === 'fisioterapeuta') {
        if (!Number.isFinite(usuarioId) || usuarioId <= 0) {
          return res.status(401).json({ sucesso: false, erro: 'Usuário inválido no token.' });
        }
        if (Number(row.FisioterapeutaId) !== Number(usuarioId)) {
          return res.status(403).json({ sucesso: false, erro: 'Acesso negado a este certificado.' });
        }
      }

      const urlPdf = `/api/arquivos/certificados/${row.Id}/visualizar`;
      const urlThumb = `/api/arquivos/certificados/${row.Id}/thumbnail`;

      const payload = {
        Id: row.Id,
        Curso: row.Curso,
        Instituicao: row.Instituicao,
        MesInicio: row.MesInicio,
        AnoInicio: row.AnoInicio,
        MesFim: row.MesFim,
        AnoFim: row.AnoFim,
        AnoConclusao: row.AnoConclusao,
        TipoFormacao: row.TipoFormacao,
        Descricao: row.Descricao,
        IdCredencial: row.IdCredencial,
        UrlCredencial: row.UrlCredencial,

        // "Media" (mídia/arquivo) = URL do PDF inline
        Media: urlPdf,

        // Thumbnail da primeira página (somente PDF; se não existir, 404 na rota específica)
        Thumbnail: urlThumb,

        // alias opcional
        UrlVisualizar: urlPdf
      };

      return res.json(omitEmpty(payload));
    } catch (err) {
      return res.status(500).json({
        sucesso: false,
        erro: 'Erro ao obter detalhes do certificado.',
        detalhe: 'Erro interno do servidor.'
      });
    }
  },

  /**
   * THUMBNAIL
   * GET /arquivos/certificados/:formacaoId/thumbnail
   *
   * - PDF: gera e serve PNG da primeira página
   * - JPG/JPEG/PNG: serve a própria imagem como miniatura
   */
  async thumbnailCertificado(req, res) {
    try {
      const row = await resolverCertificadoPublicoOuAutorizado(req.usuario, req.params.formacaoId);

      let rel;
      try {
        rel = normalizarRelCertificadoFromDb(row.CaminhoArquivo);
        validarRelCertificado(rel);
      } catch (e) {
        return res.status(400).json({ sucesso: false, erro: e.message });
      }

      if (!await fileStorageProvider.fileExists(rel)) {
        return res.status(404).json({ sucesso: false, erro: 'Arquivo não existe no servidor.' });
      }
      const lowerPath = rel.toLowerCase();
      const isPdf = lowerPath.endsWith('.pdf');
      const isHeic = isHeicStoragePath(rel);
      const isImage = ['.jpg', '.jpeg', '.png', '.webp']
        .some((ext) => lowerPath.endsWith(ext));

      if (isHeic) {
        const previewRel = await ensureHeicPreview({ sourceRelativePath: rel });
        if (!previewRel) {
          return res.status(404).json({
            sucesso: false,
            erro: 'Thumbnail indisponível para este arquivo HEIC.'
          });
        }

        return fileStorageProvider.sendFile(res, previewRel, {
          disposition: 'inline',
          fileName: path.basename(previewRel),
          contentType: 'image/jpeg',
          cacheControl: 'no-store',
        });
      }

      if (isImage) {
        return fileStorageProvider.sendFile(res, rel, {
          disposition: 'inline',
          fileName: path.basename(rel),
          cacheControl: 'no-store',
        });
      }

      if (!isPdf) {
        return res.status(404).json({
          sucesso: false,
          erro: 'Thumbnail disponível apenas para PDF ou imagem.'
        });
      }

      await fs.promises.mkdir(thumbsBase, { recursive: true });
      const thumbPath = path.resolve(thumbsBase, `${row.Id}.png`);

      if (!await fileExists(thumbPath)) {
        const tempPdfPath = path.join(os.tmpdir(), `fisiohelp-cert-${row.Id}-${Date.now()}.pdf`);
        try {
          await fileStorageProvider.downloadToFile(rel, tempPdfPath);
          await gerarThumbPdf({ pdfPath: tempPdfPath, thumbPath });
        } catch (e) {
          return res.status(500).json({
            sucesso: false,
            erro: 'Falha ao gerar thumbnail do PDF.',
            detalhe: 'Erro interno do servidor.',
            dica: 'Instale ImageMagick (magick) ou Poppler (pdftoppm) no PATH do servidor.'
          });
        } finally {
          await fs.promises.unlink(tempPdfPath).catch(() => {});
        }
      }

      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      return res.sendFile(thumbPath);
    } catch (err) {
      const status = err?.statusCode || err?.status || 500;
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro ao gerar thumbnail.' : (err?.message || 'Erro ao gerar thumbnail.'),
        detalhe: status >= 500 ? 'Erro interno do servidor.' : undefined
      });
    }
  },

  /**
   * ✅ VISUALIZAR PEDIDO MÉDICO (inline)
   * GET /arquivos/pedidos-medicos/:documentoPacienteId/visualizar
   *
   * Regra de acesso:
   * - paciente dono do documento
   * - fisioterapeuta vinculado à consulta do documento
   */
  async visualizarPedidoMedico(req, res) {
    try {
      const arquivo = await resolverPedidoMedicoAutorizado(
        req.usuario,
        req.params.documentoPacienteId
      );

      return fileStorageProvider.sendFile(res, arquivo.caminhoArquivo, {
        disposition: 'inline',
        fileName: arquivo.nomeArquivo,
        cacheControl: 'no-store',
        rangeHeader: req.headers.range,
      });
    } catch (err) {
      const status = err?.statusCode || err?.status || 500;
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro ao visualizar pedido médico.'),
      });
    }
  },

  /**
   * ✅ DOWNLOAD PEDIDO MÉDICO
   * GET /arquivos/pedidos-medicos/:documentoPacienteId/download
   *
   * Regra de acesso:
   * - paciente dono do documento
   * - fisioterapeuta vinculado à consulta do documento
   */
  async downloadPedidoMedico(req, res) {
    try {
      const arquivo = await resolverPedidoMedicoAutorizado(
        req.usuario,
        req.params.documentoPacienteId
      );

      return fileStorageProvider.sendFile(res, arquivo.caminhoArquivo, {
        disposition: 'attachment',
        fileName: arquivo.nomeArquivo,
        cacheControl: 'no-store',
        rangeHeader: req.headers.range,
      });
    } catch (err) {
      const status = err?.statusCode || err?.status || 500;
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro ao baixar pedido médico.'),
      });
    }
  },

  /**
   * ✅ UPLOAD PEDIDO MÉDICO (Paciente)
   * POST /api/arquivos/pedidos-medicos/:consultaId
   * - multipart/form-data (campo: arquivo)
   * - Salva em uploads/pedidos-medicos/
   * - Grava no banco dbo.DocumentosPacientes (TipoDocumento='AutorizacaoAtendimento' por constraint)
   * - Notifica no chat via chatService.notificarDocumentoPacienteEnviado()
   */
  async uploadPedidoMedico(req, res) {
    const usuario = req.usuario;

    try {
      const consultaId = Number(req.params.consultaId);
      if (!Number.isFinite(consultaId) || consultaId <= 0) {
        return res.status(400).json({ sucesso: false, erro: 'consultaId inválido.' });
      }

      if (!req.file) {
        return res.status(400).json({ sucesso: false, erro: 'Arquivo é obrigatório (campo: arquivo).' });
      }

      // Caminho RELATIVO dentro de uploads/
      const caminhoRelativo = normalizarRelPath(`pedidos-medicos/${req.file.filename}`);
      let arquivoSubido = false;

      await fileStorageProvider.uploadFile(caminhoRelativo, req.file.path, {
        contentType: req.file.mimetype,
        cacheControl: 'no-store',
      });
      arquivoSubido = true;

      // Registra no banco (valida consulta existe + confirmada)
      let reg;
      try {
        reg = await pacientesService.registrarPedidoMedico(usuario, {
          consultaId,
          caminhoArquivo: caminhoRelativo
        });
      } catch (err) {
        if (arquivoSubido) await fileStorageProvider.deleteFile(caminhoRelativo).catch(() => {});
        throw err;
      } finally {
        if (fileStorageProvider.isAzureBlobStorageEnabled) {
          await fileStorageProvider.cleanupLocalTempFile(req.file.path);
        }
      }

      const documentoPacienteId = reg?.documentoPacienteId ?? reg?.id ?? null;

      // Notifica no chat (best-effort)
      let notificacaoChat = { sucesso: true };
      try {
        if (documentoPacienteId) {
          await chatService.notificarDocumentoPacienteEnviado(usuario, {
            consultaId,
            documentoPacienteId
          });
        } else {
          notificacaoChat = { sucesso: false, erro: 'DocumentoPacienteId não retornou do insert.' };
        }
      } catch (e) {
        notificacaoChat = { sucesso: false, erro: e?.message || 'Falha ao notificar no chat.' };
      }

      return res.status(201).json({
        sucesso: true,
        documentoPacienteId,
        caminhoArquivo: caminhoRelativo,
        notificacaoChat
      });
    } catch (err) {
      // se deu erro antes/depois do upload, tenta remover o temporário local
      try {
        if (req.file?.path && fileStorageProvider.isAzureBlobStorageEnabled) {
          await fileStorageProvider.cleanupLocalTempFile(req.file.path);
        } else if (req.file?.path && await fileExists(req.file.path)) {
          await fs.promises.unlink(req.file.path);
        }
      } catch (_) {}

      const status = err?.httpStatus || err?.statusCode || 500;
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro ao enviar pedido médico.'),
        detalhe: status >= 500 ? undefined : err?.details
      });
    }
  }

};

export default arquivosController;





