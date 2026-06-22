// controllers/suporteController.js
import suporteService from '../services/suporteService.js';
import fileStorageProvider from '../providers/fileStorageProvider.js';

function getStatusCode(err) {
  return Number(err?.statusCode || err?.status || 500);
}

function normalizeText(v, maxLen) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function parseIntOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function parseNonNegativeIntOrNull(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

export default {
  // POST /api/suporte/disputas
  // multipart/form-data:
  // - consultaId (obrigatório)
  // - descricao (obrigatório)
  // - categoriaId (opcional)
  // - opcaoReembolso (opcional: 'Credito' | 'Reembolso')
  // - motivoDisputa (opcional)
  // - anexos[] (opcional: arquivos)
  async abrirDisputa(req, res) {
    try {
      const usuario = req.usuario;
      const consultaId = parseIntOrNull(req.body?.consultaId ?? req.body?.ConsultaId);
      const categoriaId = parseIntOrNull(req.body?.categoriaId ?? req.body?.CategoriaId);

      const descricao = normalizeText(req.body?.descricao ?? req.body?.Descricao, 4000);
      const motivoDisputa = normalizeText(req.body?.motivoDisputa ?? req.body?.MotivoDisputa, 1000);

      const opcaoReembolsoRaw = normalizeText(req.body?.opcaoReembolso ?? req.body?.OpcaoReembolso, 20);
      // SP permite apenas: 'Credito' | 'Reembolso' | NULL
      const opcaoReembolso =
        opcaoReembolsoRaw && ['CREDITO', 'REEMBOLSO'].includes(opcaoReembolsoRaw.toUpperCase())
          ? (opcaoReembolsoRaw.toUpperCase() === 'CREDITO' ? 'Credito' : 'Reembolso')
          : null;

      const arquivos = Array.isArray(req.files) ? req.files : (req.files?.anexos ? req.files.anexos : []) || (req.file ? [req.file] : []);


      const resultado = await suporteService.abrirDisputaFaleConosco({
        usuario,
        consultaId,
        categoriaId,
        descricao,
        opcaoReembolso,
        motivoDisputa,
        files: arquivos,
      });

      return res.json({ sucesso: true, resultado });
    } catch (err) {
      const status = getStatusCode(err);
      return res.status(status).json({ sucesso: false, erro: status >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro ao abrir disputa via Suporte.') });
    }
  },

  // POST /api/suporte/chamados
  // multipart/form-data:
  // - descricao (obrigatório)
  // - categoriaId (opcional)
  // - categoriaNome (opcional, usado para resolver a categoria por nome)
  // - consultaId (opcional)
  // - anexos[] (opcional: arquivos)
  async abrirChamadoGeral(req, res) {
    try {
      const usuario = req.usuario;
      const consultaId = parseIntOrNull(
        req.body?.consultaId ?? req.body?.ConsultaId ?? req.body?.consulta_id
      );
      const categoriaId = parseIntOrNull(
        req.body?.categoriaId ?? req.body?.CategoriaId ?? req.body?.categoria_id
      );
      const categoriaNome = normalizeText(
        req.body?.categoriaNome ?? req.body?.CategoriaNome ?? req.body?.categoria_nome,
        120
      );
      const descricao = normalizeText(req.body?.descricao ?? req.body?.Descricao, 4000);
      const arquivos = Array.isArray(req.files) ? req.files : (req.files?.anexos ? req.files.anexos : []) || (req.file ? [req.file] : []);

      const resultado = await suporteService.abrirChamadoGeralFaleConosco({
        usuario,
        consultaId,
        categoriaId,
        categoriaNome,
        descricao,
        files: arquivos,
      });

      return res.json({ sucesso: true, resultado });
    } catch (err) {
      const status = getStatusCode(err);
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro ao abrir chamado via Suporte.'),
      });
    }
  },

  // GET /api/suporte/chamados?chamadoId=1&status=Aberto
  async listarChamadosAdmin(req, res) {
    try {
      const usuario = req.usuario;

      const chamadoId = parseIntOrNull(req.query?.chamadoId ?? req.query?.id ?? null);
      const status = normalizeText(req.query?.status ?? null, 60);
      const limit = parseIntOrNull(req.query?.limit);
      const offset = parseNonNegativeIntOrNull(req.query?.offset);

      const resultado = await suporteService.listarChamadosAdmin({
        usuario,
        chamadoId,
        status,
        limit,
        offset,
      });

      return res.json({ sucesso: true, resultado });
    } catch (err) {
      const statusCode = getStatusCode(err);
      return res.status(statusCode).json({
        sucesso: false,
        erro: statusCode >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro ao listar chamados de suporte.'),
      });
    }
  },

  async baixarAnexoChamadoAdmin(req, res) {
    try {
      const usuario = req.usuario;
      const chamadoId = parseIntOrNull(req.params?.id ?? req.params?.chamadoId);
      const anexoId = parseIntOrNull(req.params?.anexoId);

      const arquivo = await suporteService.baixarAnexoChamadoAdmin({
        usuario,
        chamadoId,
        anexoId,
      });

      return fileStorageProvider.sendFile(res, arquivo.caminhoArquivo, {
        disposition: 'attachment',
        fileName: arquivo.nomeArquivo,
        contentType: arquivo.mimeType,
        cacheControl: 'no-store',
        rangeHeader: req.headers.range,
      });
    } catch (err) {
      const statusCode = getStatusCode(err);
      return res.status(statusCode).json({
        sucesso: false,
        erro: statusCode >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro ao baixar anexo do chamado.'),
      });
    }
  },

  // PATCH /api/suporte/chamados/:id/status
  async atualizarStatusChamadoAdmin(req, res) {
    try {
      const usuario = req.usuario;

      const chamadoId = parseIntOrNull(req.params?.id);
      const status = normalizeText(req.body?.status ?? req.body?.Status, 60);
      const observacoesInternas = normalizeText(
        req.body?.observacoesInternas ?? req.body?.ObservacoesInternas ?? null,
        500
      );

      const resultado = await suporteService.atualizarStatusChamadoAdmin({
        usuario,
        chamadoId,
        status,
        observacoesInternas,
      });

      return res.json({ sucesso: true, resultado });
    } catch (err) {
      const statusCode = getStatusCode(err);
      return res.status(statusCode).json({
        sucesso: false,
        erro: statusCode >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro ao atualizar status do chamado.'),
      });
    }
  },
  // LISTAR CHAMADOS - PACIENTE ou FISIOTERAPEUTA (somente os seus)
  async listarMeusChamados(req, res) {
    try {
      const usuario = req.usuario;

      const chamadoId = req.query?.chamadoId ?? req.query?.ChamadoId ?? null;
      const status = req.query?.status ?? req.query?.Status ?? null;
      const limit = parseIntOrNull(req.query?.limit);
      const offset = parseNonNegativeIntOrNull(req.query?.offset);

      const resultado = await suporteService.listarMeusChamados({
        usuario,
        chamadoId,
        status,
        limit,
        offset,
      });

      return res.json({ sucesso: true, resultado });
    } catch (err) {
      const statusCode = Number(err?.statusCode || err?.status) || 500;
      return res.status(statusCode).json({
        sucesso: false,
        erro: statusCode >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro ao listar seus chamados.'),
      });
    }
  },
};
