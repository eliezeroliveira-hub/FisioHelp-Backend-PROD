// services/suporteService.js

// Fluxo: Paciente abre contestação via Suporte (janela de 30 dias) + anexos (opcional).
//
// Requisito RLS:
// - Sempre usar queryWithContext(usuario, ...) para que o SESSION_CONTEXT seja setado antes das queries.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import notificacoesDispatch from './notificacoesDispatch.js';
import { HttpError } from '../utils/httpError.js';

function requireUser(usuario) {
  if (!usuario || !usuario.id || !usuario.tipo) {
    throw new HttpError(401, 'Usuário não autenticado.');
  }
}

function isAdmin(usuario) {
  return String(usuario?.tipo || '').trim().toLowerCase() === 'admin';
}

function isPaciente(usuario) {
  return String(usuario?.tipo || '').trim().toLowerCase() === 'paciente';
}

function isFisioterapeuta(usuario) {
  return String(usuario?.tipo || '').trim().toLowerCase() === 'fisioterapeuta';
}

function assertId(v, nome = 'Id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, `${nome} inválido.`);
  }
  return n;
}

function normalizeText(v, maxLen = 4000) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function buildLookupKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function parseOptionalId(value, nome = 'Id') {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return assertId(value, nome);
}

function normalizeOpcaoReembolso(value) {
  const v = normalizeText(value, 20);
  if (!v) return null;

  // Aceita apenas o que a SP permite
  const norm = v.toLowerCase();
  if (norm === 'credito') return 'Credito';
  if (norm === 'reembolso') return 'Reembolso';

  // Se veio qualquer outra coisa, cai fora para evitar erro na SP
  throw new HttpError(400, 'OpcaoReembolso inválida. Use "Credito" ou "Reembolso".');
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function moveFileSafe(src, dst) {
  try {
    await fs.promises.rename(src, dst);
    return;
  } catch (err) {
    // Cross-device move (EXDEV): fallback para copy + unlink
    if (err?.code !== 'EXDEV') throw err;
  }

  await fs.promises.copyFile(src, dst);
  await fs.promises.unlink(src);
}

function buildSafeFileName(originalName) {
  const ext = path.extname(originalName || '').slice(0, 12).toLowerCase();
  const token = crypto.randomBytes(12).toString('hex');
  return `${Date.now()}_${token}${ext}`;
}

function toUploadsRelative(relPath) {
  // Armazenamos no banco SEM o prefixo "uploads/", igual ao padrão de outros uploads.
  // Ex: "suporte/123/arquivo.png"
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function resolveUploadsAbsolutePath(relPath, label = 'Arquivo') {
  const caminho = String(relPath || '').trim();
  if (!caminho) {
    throw new HttpError(404, `${label} não possui caminho de arquivo.`);
  }

  if (path.isAbsolute(caminho)) {
    throw new HttpError(400, 'Caminho absoluto não é permitido. Use caminho relativo em uploads/.');
  }

  const relative = caminho
    .replace(/^[\\/]+/, '')
    .replace(/\\/g, '/')
    .replace(/^uploads\//i, '');

  const absolute = path.resolve(UPLOADS_DIR, relative);
  const relativeToRoot = path.relative(UPLOADS_DIR, absolute);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new HttpError(400, 'Caminho de arquivo inválido.');
  }

  return absolute;
}

const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
const TMP_DIR = path.resolve(UPLOADS_DIR, 'tmp');
const SUPORTE_DIR = path.resolve(UPLOADS_DIR, 'suporte');
const MAX_CHAMADOS_PAGE_SIZE = 200;
const DEFAULT_CHAMADOS_PAGE_SIZE = 50;
const MAX_ANEXOS_POR_CHAMADO = 5;

const STATUS_MAP = Object.freeze({
  ABERTO: 'Aberto',
  EMANALISE: 'EmAnalise',
  AGUARDANDOCLIENTE: 'AguardandoCliente',
  CONCLUIDO: 'Concluido',
  CONCLUÍDO: 'Concluido',
  CANCELADO: 'Cancelado',
  // Alias legado para compatibilidade retroativa
  EMANDAMENTO: 'EmAnalise',
});

const CHAMADO_STATUS_TRANSITIONS = Object.freeze({
  Aberto: new Set(['Aberto', 'EmAnalise', 'AguardandoCliente', 'Concluido', 'Cancelado']),
  EmAnalise: new Set(['EmAnalise', 'AguardandoCliente', 'Concluido', 'Cancelado']),
  AguardandoCliente: new Set(['AguardandoCliente', 'EmAnalise', 'Concluido', 'Cancelado']),
  Concluido: new Set(['Concluido']),
  Cancelado: new Set(['Cancelado']),
});
const ALLOWED_SUPORTE_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);
const CATEGORIA_NOME_ALIASES = Object.freeze({
  duvidas: 'Dúvidas',
  reclamacoes: 'Reclamações',
  suporte: 'Suporte',
  contestacoes: 'Contestações',
});

function normalizeChamadoStatus(value) {
  const raw = normalizeText(value, 60);
  if (!raw) return null;
  const key = raw.toUpperCase().replace(/\s+/g, '');
  return STATUS_MAP[key] || null;
}

function canTransitionChamadoStatus(statusAtual, statusNovo) {
  const from = normalizeChamadoStatus(statusAtual) || String(statusAtual || '').trim();
  const to = normalizeChamadoStatus(statusNovo) || String(statusNovo || '').trim();
  const allowed = CHAMADO_STATUS_TRANSITIONS[from];
  return !!allowed && allowed.has(to);
}

function isAllowedSuporteMime(mime) {
  const value = String(mime || '').trim().toLowerCase();
  return ALLOWED_SUPORTE_MIMES.has(value);
}

function normalizePagination(limitRaw, offsetRaw) {
  const l = Number(limitRaw);
  const o = Number(offsetRaw);
  const limit = Number.isInteger(l) && l > 0 ? Math.min(l, MAX_CHAMADOS_PAGE_SIZE) : DEFAULT_CHAMADOS_PAGE_SIZE;
  const offset = Number.isInteger(o) && o >= 0 ? o : 0;
  return { limit, offset };
}

function normalizeCategoriaNome(value) {
  const raw = normalizeText(value, 120);
  if (!raw) return null;
  return CATEGORIA_NOME_ALIASES[buildLookupKey(raw)] || raw;
}

function normalizeUploadedFiles(files = []) {
  return Array.isArray(files) ? files.filter(Boolean) : [];
}

async function cleanupUploadedTempFiles(files = []) {
  await Promise.all(
    normalizeUploadedFiles(files).map((file) => (
      file?.path ? fs.promises.unlink(file.path).catch(() => {}) : Promise.resolve()
    ))
  );
}

async function validateSuporteFiles(files = []) {
  const normalizedFiles = normalizeUploadedFiles(files);

  if (normalizedFiles.length > MAX_ANEXOS_POR_CHAMADO) {
    await cleanupUploadedTempFiles(normalizedFiles);
    throw new HttpError(400, `Máximo ${MAX_ANEXOS_POR_CHAMADO} anexos por chamado.`);
  }

  for (const file of normalizedFiles) {
    if (!isAllowedSuporteMime(file?.mimetype)) {
      await cleanupUploadedTempFiles(normalizedFiles);
      throw new HttpError(400, 'Tipo de arquivo não permitido.');
    }
  }

  return normalizedFiles;
}

async function resolveCategoriaId({ usuario, categoriaId = null, categoriaNome = null }) {
  const normalizedCategoriaId = parseOptionalId(categoriaId, 'CategoriaId');
  if (normalizedCategoriaId !== null) return normalizedCategoriaId;

  const normalizedCategoriaNome = normalizeCategoriaNome(categoriaNome);
  if (!normalizedCategoriaNome) return null;

  const categoriaRes = await queryWithContext(
    usuario,
    (req) => {
      req.input('CategoriaNome', sql.NVarChar(120), normalizedCategoriaNome);
    },
    `
      SELECT TOP (1) Id
      FROM dbo.FaleConoscoCategorias
      WHERE Ativa = 1
        AND UPPER(LTRIM(RTRIM(Nome))) = UPPER(@CategoriaNome);
    `
  );

  const resolvedId = Number(categoriaRes?.recordset?.[0]?.Id ?? 0);
  if (!Number.isInteger(resolvedId) || resolvedId <= 0) {
    throw new HttpError(400, `Categoria inválida: "${normalizedCategoriaNome}".`);
  }

  return resolvedId;
}

async function salvarAnexosChamado({ usuario, chamadoId, files = [] }) {
  const normalizedChamadoId = Number(chamadoId || 0);
  const normalizedFiles = normalizeUploadedFiles(files);
  if (normalizedChamadoId <= 0 || normalizedFiles.length === 0) return [];

  await ensureDir(TMP_DIR);
  await ensureDir(SUPORTE_DIR);

  const finalDir = path.resolve(SUPORTE_DIR, String(normalizedChamadoId));
  await ensureDir(finalDir);

  const anexosInseridos = [];

  for (const file of normalizedFiles) {
    const src = file?.path;
    if (!src) {
      throw new HttpError(400, 'Arquivo inválido.');
    }

    const safeName = buildSafeFileName(file.originalname);
    const dst = path.resolve(finalDir, safeName);

    await moveFileSafe(src, dst);

    const rel = toUploadsRelative(path.join('suporte', String(normalizedChamadoId), safeName));

    try {
      await queryWithContext(
        usuario,
        (req) => {
          req.input('ChamadoId', sql.Int, normalizedChamadoId);
          req.input('CaminhoRelativo', sql.NVarChar(1000), rel);
          req.input('NomeOriginal', sql.NVarChar(260), normalizeText(file.originalname, 260));
          req.input('MimeType', sql.NVarChar(100), normalizeText(file.mimetype, 100));
          req.input('TamanhoBytes', sql.BigInt, Number(file.size || 0));
        },
        `
          INSERT INTO dbo.FaleConoscoChamadoAnexos
            (ChamadoId, CaminhoRelativo, NomeOriginal, MimeType, TamanhoBytes)
          VALUES
            (@ChamadoId, @CaminhoRelativo, @NomeOriginal, @MimeType, @TamanhoBytes);
        `
      );
    } catch (err) {
      await fs.promises.unlink(dst).catch(() => {});
      throw err;
    }

    anexosInseridos.push(rel);
  }

  return anexosInseridos;
}

async function listarChamadosComAnexos({ usuario, chamadoId = null, status = null, limit = null, offset = null, pacienteId = null, userId = null, userTipo = null }) {
  const id = chamadoId ? assertId(chamadoId, 'ChamadoId') : null;
  const statusFinal = normalizeChamadoStatus(status);
  const pag = normalizePagination(limit, offset);

  // Suporte legado: pacienteId (compatibilidade) ou novo: userId + userTipo
  const resolvedUserId = userId ?? pacienteId;
  const resolvedUserTipo = userTipo ?? (pacienteId != null ? 'Paciente' : null);
  const escopoUsuario = Number.isInteger(Number(resolvedUserId)) && Number(resolvedUserId) > 0 && !!resolvedUserTipo;

  const whereFiltro = escopoUsuario
    ? `fc.UsuarioTipo = @UserTipo
        AND fc.UsuarioId = @UserId
        AND (@ChamadoId IS NULL OR fc.Id = @ChamadoId)
        AND (@Status IS NULL OR LTRIM(RTRIM(fc.Status)) = @Status)`
    : `(@ChamadoId IS NULL OR fc.Id = @ChamadoId)
        AND (@Status IS NULL OR LTRIM(RTRIM(fc.Status)) = @Status)`;

  const r = await queryWithContext(usuario, (req) => {
    if (escopoUsuario) {
      req.input('UserId', sql.Int, Number(resolvedUserId));
      req.input('UserTipo', sql.NVarChar(30), String(resolvedUserTipo));
    }
    req.input('ChamadoId', sql.Int, id);
    req.input('Status', sql.NVarChar(60), statusFinal);
    req.input('Limit', sql.Int, pag.limit);
    req.input('Offset', sql.Int, pag.offset);
  }, `
    DECLARE @Filtro TABLE (Id INT PRIMARY KEY);

    SELECT COUNT(1) AS TotalRegistros
    FROM dbo.FaleConoscoChamados fc WITH (NOLOCK)
    WHERE ${whereFiltro};

    INSERT INTO @Filtro (Id)
    SELECT fc.Id
    FROM dbo.FaleConoscoChamados fc WITH (NOLOCK)
    WHERE ${whereFiltro}
    ORDER BY fc.Id DESC
    OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;

    SELECT
      fc.Id AS ChamadoId,
      fc.Protocolo,
      fc.ProtocoloTexto,
      fc.DataAbertura,
      fc.CategoriaId,
      cat.Nome AS CategoriaNome,
      LTRIM(RTRIM(fc.Status)) AS Status,
      fc.NomeSolicitante,
      fc.EmailSolicitante,
      fc.ContatoSolicitante,
      fc.UsuarioTipo,
      fc.UsuarioId,
      fc.ConsultaId,
      fc.Descricao,
      fc.PrazoLimiteResposta,
      fc.DataConclusao,
      fc.UltimaAtualizacao
    FROM dbo.FaleConoscoChamados fc WITH (NOLOCK)
    LEFT JOIN dbo.FaleConoscoCategorias cat WITH (NOLOCK)
      ON cat.Id = fc.CategoriaId
    WHERE fc.Id IN (SELECT Id FROM @Filtro)
    ORDER BY fc.Id DESC;

    SELECT
      a.Id,
      a.ChamadoId,
      a.CaminhoRelativo,
      a.NomeOriginal,
      a.MimeType,
      a.TamanhoBytes
    FROM dbo.FaleConoscoChamadoAnexos a WITH (NOLOCK)
    WHERE a.ChamadoId IN (SELECT Id FROM @Filtro)
    ORDER BY a.ChamadoId, a.Id;
  `);

  const totalRegistros = Number(r?.recordsets?.[0]?.[0]?.TotalRegistros ?? 0);
  const chamados = r?.recordsets?.[1] ?? [];
  const anexos = r?.recordsets?.[2] ?? [];

  const map = new Map();
  for (const a of anexos) {
    const k = Number(a.ChamadoId);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({
      Id: a.Id,
      CaminhoRelativo: a.CaminhoRelativo,
      NomeOriginal: a.NomeOriginal,
      MimeType: a.MimeType,
      TamanhoBytes: a.TamanhoBytes,
    });
  }

  const chamadosComAnexos = chamados.map((c) => ({
    ...c,
    Anexos: map.get(Number(c.ChamadoId)) ?? [],
  }));

  return {
    filtros: { chamadoId: id, status: statusFinal, limit: pag.limit, offset: pag.offset },
    total: totalRegistros,
    totalRegistros,
    totalNaPagina: chamadosComAnexos.length,
    chamados: chamadosComAnexos,
  };
}

const suporteService = {
  /**
   * Abre disputa + chamado do Suporte (SP) e salva anexos (opcional).
   * @param {object} params
   * @param {object} params.usuario - { id, tipo }
   * @param {number} params.consultaId
   * @param {number|null} params.categoriaId
   * @param {string} params.descricao
   * @param {string|null} params.opcaoReembolso - 'Credito' | 'Reembolso' | null
   * @param {string|null} params.motivoDisputa
   * @param {Array} params.files - req.files (multer)
   */
  async abrirDisputaFaleConosco({ usuario, consultaId, categoriaId = null, descricao, opcaoReembolso = null, motivoDisputa = null, files = [] }) {
    requireUser(usuario);

    const _consultaId = Number(consultaId);
    if (!Number.isInteger(_consultaId) || _consultaId <= 0) throw new HttpError(400, 'ConsultaId inválido.');

    const _categoriaId = await resolveCategoriaId({ usuario, categoriaId });

    const _descricao = normalizeText(descricao, 4000);
    if (!_descricao) throw new HttpError(400, 'Descricao é obrigatório.');

    const _opcao = normalizeOpcaoReembolso(opcaoReembolso);
    const _motivo = normalizeText(motivoDisputa, 1000);
    const arquivos = await validateSuporteFiles(files);

    const consultaCheck = await queryWithContext(
      usuario,
      (req) => {
        req.input('ConsultaId', sql.Int, _consultaId);
        req.input('PacienteId', sql.Int, Number(usuario.id));
      },
      `
        SELECT Status, StatusPagamento, DataContestacao, PagamentoViaPlataforma, DataHora
        FROM dbo.Consultas
        WHERE Id = @ConsultaId AND PacienteId = @PacienteId;
      `
    );

    if (!consultaCheck.recordset?.length) {
      throw new HttpError(404, 'Consulta não encontrada.');
    }

    const {
      Status,
      StatusPagamento,
      DataContestacao,
      PagamentoViaPlataforma,
      DataHora,
    } = consultaCheck.recordset[0];

    const pagamentoViaPlataforma =
      PagamentoViaPlataforma === true ||
      PagamentoViaPlataforma === 1 ||
      PagamentoViaPlataforma === '1';
    const dataHoraMs = new Date(DataHora ?? 0).getTime();
    const janelaContestacaoLimiteMs = dataHoraMs + (30 * 24 * 60 * 60 * 1000);

    if (!['Concluída', 'Paciente Ausente'].includes(Status)) {
      throw new HttpError(
        400,
        `Contestação não permitida: a consulta precisa estar com status "Concluída" ou "Paciente Ausente" (atual: "${Status}").`
      );
    }

    if (!Number.isFinite(dataHoraMs)) {
      throw new HttpError(400, 'Contestação não permitida: consulta sem data válida para validar a janela de 30 dias.');
    }

    if (Date.now() > janelaContestacaoLimiteMs) {
      throw new HttpError(400, 'Contestação não permitida: janela de 30 dias para contestação expirada.');
    }

    if (!pagamentoViaPlataforma) {
      throw new HttpError(
        400,
        'Contestação não permitida: a consulta precisa ter sido paga dentro da plataforma.'
      );
    }

    if (StatusPagamento !== 'Pago') {
      throw new HttpError(
        400,
        `Contestação não permitida: pagamento precisa estar "Pago" (atual: "${StatusPagamento}").`
      );
    }

    if (DataContestacao) {
      throw new HttpError(409, 'Esta consulta já possui uma contestação aberta.');
    }

    // 1) Abre disputa + chamado (SP)
    try {
      const spRes = await queryWithContext(
        usuario,
        (req) => {
          req.input('ConsultaId', sql.Int, _consultaId);
          req.input('PacienteId', sql.Int, Number(usuario.id));
          req.input('CategoriaId', sql.Int, _categoriaId);
          req.input('Descricao', sql.NVarChar(4000), _descricao);
          req.input('OpcaoReembolso', sql.NVarChar(20), _opcao);
          req.input('MotivoDisputa', sql.NVarChar(1000), _motivo);
        },
        `
          EXEC dbo.SP_AbrirDisputa_FaleConosco
            @ConsultaId = @ConsultaId,
            @PacienteId = @PacienteId,
            @CategoriaId = @CategoriaId,
            @Descricao = @Descricao,
            @OpcaoReembolso = @OpcaoReembolso,
            @MotivoDisputa = @MotivoDisputa;
        `
      );

      const resultado = spRes?.recordset?.[0] ?? null;
      if (!resultado) throw new HttpError(500, 'Falha ao abrir chamado. SP não retornou resultado.');

      const anexosInseridos = await salvarAnexosChamado({
        usuario,
        chamadoId: Number(resultado.ChamadoId || 0),
        files: arquivos,
      });

      void notificacoesDispatch.chamadoAberto({
        chamadoId: Number(resultado.ChamadoId || 0)
      });

      return { ...resultado, Anexos: anexosInseridos };
    } catch (err) {
      await cleanupUploadedTempFiles(arquivos);
      throw err;
    }
  },

  /**
   * Abre chamado genérico de Suporte (SP) e salva anexos (opcional).
   * @param {object} params
   * @param {object} params.usuario - { id, tipo }
   * @param {number|null} params.consultaId
   * @param {number|null} params.categoriaId
   * @param {string|null} params.categoriaNome
   * @param {string} params.descricao
   * @param {Array} params.files - req.files (multer)
   */
  async abrirChamadoGeralFaleConosco({ usuario, consultaId = null, categoriaId = null, categoriaNome = null, descricao, files = [] }) {
    requireUser(usuario);

    const _consultaId = parseOptionalId(consultaId, 'ConsultaId');
    const _categoriaId = await resolveCategoriaId({ usuario, categoriaId, categoriaNome });
    const _descricao = normalizeText(descricao, 4000);
    if (!_descricao) throw new HttpError(400, 'Descricao é obrigatório.');

    const arquivos = await validateSuporteFiles(files);

    try {
      let spRes;

      if (isFisioterapeuta(usuario)) {
        // Fisio: usa SP dedicada (SP_AbrirChamadoGeral_FaleConosco é paciente-específica)
        spRes = await queryWithContext(
          usuario,
          (req) => {
            req.input('FisioterapeutaId', sql.Int, Number(usuario.id));
            req.input('CategoriaId', sql.Int, _categoriaId);
            req.input('Descricao', sql.NVarChar(4000), _descricao);
            req.input('ConsultaId', sql.Int, _consultaId);
          },
          `
            EXEC dbo.SP_AbrirChamadoGeral_FaleConosco_Fisio
              @FisioterapeutaId = @FisioterapeutaId,
              @CategoriaId      = @CategoriaId,
              @Descricao        = @Descricao,
              @ConsultaId       = @ConsultaId;
          `
        );
      } else {
        // Paciente: usa SP existente
        spRes = await queryWithContext(
          usuario,
          (req) => {
            req.input('PacienteId', sql.Int, Number(usuario.id));
            req.input('CategoriaId', sql.Int, _categoriaId);
            req.input('Descricao', sql.NVarChar(4000), _descricao);
            req.input('ConsultaId', sql.Int, _consultaId);
          },
          `
            EXEC dbo.SP_AbrirChamadoGeral_FaleConosco
              @PacienteId = @PacienteId,
              @CategoriaId = @CategoriaId,
              @Descricao = @Descricao,
              @ConsultaId = @ConsultaId;
          `
        );
      }

      const resultado = spRes?.recordset?.[0] ?? null;
      if (!resultado) throw new HttpError(500, 'Falha ao abrir chamado. SP não retornou resultado.');

      const anexosInseridos = await salvarAnexosChamado({
        usuario,
        chamadoId: Number(resultado.ChamadoId || 0),
        files: arquivos,
      });

      void notificacoesDispatch.chamadoAberto({
        chamadoId: Number(resultado.ChamadoId || resultado.Id || 0)
      });

      return { ...resultado, Anexos: anexosInseridos };
    } catch (err) {
      await cleanupUploadedTempFiles(arquivos);
      throw err;
    }
  },

  //LISTAR CHAMADOS - ADMIN
    async listarChamadosAdmin({ usuario, chamadoId = null, status = null, limit = null, offset = null }) {
    requireUser(usuario);
    if (!isAdmin(usuario)) {
      throw new HttpError(403, 'Somente Admin pode listar chamados de suporte.');
    }
    return listarChamadosComAnexos({ usuario, chamadoId, status, limit, offset });
  },

  //Atualiza Status de chamado
  async atualizarStatusChamadoAdmin({ usuario, chamadoId, status, observacoesInternas = null }) {
    requireUser(usuario);
    if (!isAdmin(usuario)) throw new HttpError(403, 'Acesso negado.');

    const id = assertId(chamadoId, 'ChamadoId');

    const raw = normalizeText(status, 60);
    if (!raw) throw new HttpError(400, 'Status é obrigatório.');

    const statusFinal = normalizeChamadoStatus(raw);
    if (!statusFinal) {
      throw new HttpError(
        400,
        'Status inválido. Use: Aberto, EmAnalise, AguardandoCliente, Concluido ou Cancelado.'
      );
    }

    const obs = normalizeText(observacoesInternas, 500);

    const atual = await queryWithContext(
      usuario,
      (req) => {
        req.input('ChamadoId', sql.Int, id);
      },
      `
        SELECT TOP 1
          LTRIM(RTRIM(Status)) AS StatusAtual
        FROM dbo.FaleConoscoChamados
        WHERE Id = @ChamadoId;
      `
    );

    const statusAtual = atual?.recordset?.[0]?.StatusAtual;
    if (!statusAtual) throw new HttpError(404, 'Chamado não encontrado.');
    if (!canTransitionChamadoStatus(statusAtual, statusFinal)) {
      throw new HttpError(409, `Transição de status inválida: ${statusAtual} -> ${statusFinal}.`);
    }

    const r = await queryWithContext(
      usuario,
      (req) => {
        req.input('ChamadoId', sql.Int, id);
        req.input('StatusAtual', sql.NVarChar(60), statusAtual);
        req.input('Status', sql.NVarChar(60), statusFinal);
        req.input('Obs', sql.NVarChar(500), obs);
      },
      `
        UPDATE dbo.FaleConoscoChamados
        SET
          Status = @Status,
          DataConclusao = CASE
            WHEN @Status IN (N'Concluido', N'Cancelado') THEN COALESCE(DataConclusao, SYSDATETIME())
            ELSE NULL
          END,
          UltimaAtualizacao = SYSDATETIME(),
          ObservacoesInternas = CASE
            WHEN @Obs IS NULL OR LTRIM(RTRIM(@Obs)) = N'' THEN ObservacoesInternas
            ELSE LEFT(
              CONCAT(
                COALESCE(NULLIF(ObservacoesInternas, N''), N''),
                CASE WHEN ObservacoesInternas IS NULL OR ObservacoesInternas = N'' THEN N'' ELSE N' | ' END,
                @Obs
              ),
              500
            )
          END
        WHERE Id = @ChamadoId
          AND LTRIM(RTRIM(Status)) = @StatusAtual;

        SELECT @@ROWCOUNT AS Affected;
      `
    );

    const affected = r?.recordset?.[0]?.Affected != null ? Number(r.recordset[0].Affected) : 0;
    if (!affected) {
      const existe = await queryWithContext(
        usuario,
        (req) => {
          req.input('ChamadoId', sql.Int, id);
        },
        `SELECT TOP 1 Id FROM dbo.FaleConoscoChamados WHERE Id = @ChamadoId;`
      );
      if (!existe?.recordset?.[0]) throw new HttpError(404, 'Chamado não encontrado ou não atualizado.');
      throw new HttpError(409, 'O status do chamado foi alterado por outra operação. Recarregue e tente novamente.');
    }

    void notificacoesDispatch.chamadoAtualizado({
      chamadoId: id,
      status: statusFinal
    });

    return { chamadoId: id, status: statusFinal };
  },

  async baixarAnexoChamadoAdmin({ usuario, chamadoId, anexoId }) {
    requireUser(usuario);
    if (!isAdmin(usuario)) {
      throw new HttpError(403, 'Somente Admin pode baixar anexos de chamados de suporte.');
    }

    const normalizedChamadoId = assertId(chamadoId, 'ChamadoId');
    const normalizedAnexoId = assertId(anexoId, 'AnexoId');

    const r = await queryWithContext(
      usuario,
      (req) => {
        req.input('ChamadoId', sql.Int, normalizedChamadoId);
        req.input('AnexoId', sql.Int, normalizedAnexoId);
      },
      `
        SELECT TOP (1)
          a.Id AS AnexoId,
          a.ChamadoId,
          a.CaminhoRelativo,
          a.NomeOriginal,
          a.MimeType
        FROM dbo.FaleConoscoChamadoAnexos a WITH (NOLOCK)
        INNER JOIN dbo.FaleConoscoChamados fc WITH (NOLOCK)
          ON fc.Id = a.ChamadoId
        WHERE a.ChamadoId = @ChamadoId
          AND a.Id = @AnexoId;
      `
    );

    const row = r?.recordset?.[0];
    if (!row) {
      throw new HttpError(404, 'Anexo do chamado não encontrado.');
    }

    const caminhoArquivo = resolveUploadsAbsolutePath(row.CaminhoRelativo, 'Anexo');

    try {
      await fs.promises.access(caminhoArquivo, fs.constants.F_OK);
    } catch {
      throw new HttpError(404, 'Arquivo do anexo não existe no servidor.');
    }

    return {
      caminhoArquivo,
      nomeArquivo: normalizeText(row.NomeOriginal, 260) || path.basename(caminhoArquivo),
      mimeType: normalizeText(row.MimeType, 100) || 'application/octet-stream',
    };
  },

  // LISTAR CHAMADOS - PACIENTE (somente os seus) — mantido por compatibilidade interna
  async listarChamadosPaciente({ usuario, chamadoId = null, status = null, limit = null, offset = null }) {
    requireUser(usuario);
    if (!isPaciente(usuario)) {
      throw new HttpError(403, 'Somente Paciente pode listar seus chamados de suporte.');
    }

    const pacienteId = assertId(usuario.id, 'PacienteId');
    return listarChamadosComAnexos({ usuario, chamadoId, status, limit, offset, pacienteId });
  },

  // LISTAR CHAMADOS - PACIENTE ou FISIOTERAPEUTA (somente os seus)
  async listarMeusChamados({ usuario, chamadoId = null, status = null, limit = null, offset = null }) {
    requireUser(usuario);
    if (!isPaciente(usuario) && !isFisioterapeuta(usuario)) {
      throw new HttpError(403, 'Acesso negado.');
    }

    const userId = assertId(usuario.id, 'UsuarioId');
    const userTipo = isPaciente(usuario) ? 'Paciente' : 'Fisioterapeuta';
    return listarChamadosComAnexos({ usuario, chamadoId, status, limit, offset, userId, userTipo });
  },

};

export default suporteService;
