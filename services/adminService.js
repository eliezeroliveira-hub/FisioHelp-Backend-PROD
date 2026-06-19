//  services/adminService.js
import { sql } from '../config/dbConfig.js';
import fs from 'fs';
import path from 'path';
import { queryWithContext } from './_queryWithContext.js';
import notificacoesDispatch from './notificacoesDispatch.js';
import { HttpError } from '../utils/httpError.js';
import { normalizeCNPJ } from '../utils/identityValidators.js';

const YOUTUBE_RE = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/).+/i;
const STATUS_DOCUMENTO_VALIDOS = new Set(['Aprovado', 'Reprovado', 'Pendente']);
const ENTIDADES_AUDITORIA_VALIDAS = new Set(['Fisioterapeuta', 'Paciente']);
const ACOES_AUDITORIA_VALIDAS = new Set(['Bloquear', 'Desbloquear', 'Ativar', 'Desativar']);
const CAMPOS_ESTADO_VALIDOS = new Set(['Ativo', 'IsBloqueado']);

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function assertId(value, label = 'Id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `${label} inválido.`);
  return id;
}

function assertValorPositivo(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${label} inválido.`);
  return n;
}

function normalizeLimitOffset(limitRaw, offsetRaw) {
  const l = Number(limitRaw);
  const o = Number(offsetRaw);
  const limit = Number.isInteger(l) && l > 0 ? Math.min(l, 200) : 200;
  const offset = Number.isInteger(o) && o >= 0 ? o : 0;
  return { limit, offset };
}

function normalizeAuditMeta(meta = {}) {
  const ip = meta?.ip == null ? null : String(meta.ip).trim().slice(0, 64);
  const userAgent = meta?.userAgent == null ? null : String(meta.userAgent).trim().slice(0, 400);
  return {
    ip: ip || null,
    userAgent: userAgent || null,
  };
}

function resolveEstadoTarget(entidade, campo, acao) {
  if (!ENTIDADES_AUDITORIA_VALIDAS.has(entidade)) {
    throw new HttpError(400, 'Entidade inválida para atualização de estado.');
  }
  if (!ACOES_AUDITORIA_VALIDAS.has(acao)) {
    throw new HttpError(400, 'Ação inválida para atualização de estado.');
  }
  if (!CAMPOS_ESTADO_VALIDOS.has(campo)) {
    throw new HttpError(400, 'Campo de estado inválido.');
  }

  const acaoPorCampo = {
    IsBloqueado: new Set(['Bloquear', 'Desbloquear']),
    Ativo: new Set(['Ativar', 'Desativar'])
  };
  if (!acaoPorCampo[campo]?.has(acao)) {
    throw new HttpError(400, 'Combinação ação/campo inválida.');
  }

  return { entidadeSafe: entidade, campoSafe: campo, acaoSafe: acao };
}

async function aplicarAcaoEstadoEntidade(usuario, {
  entidade,
  entidadeId,
  acao,
  campo,
  novoValor,
  auditMeta = {}
}) {
  const { entidadeSafe, campoSafe, acaoSafe } = resolveEstadoTarget(entidade, campo, acao);

  const id = assertId(entidadeId, 'Id');
  const adminId = assertId(usuario?.id, 'AdminId');
  const audit = normalizeAuditMeta(auditMeta);

  const r = await queryWithContext(
    usuario,
    (request) => request
      .input('EntidadeId', sql.Int, id)
      .input('AdminId', sql.Int, adminId)
      .input('NovoValor', sql.Bit, novoValor ? 1 : 0)
      .input('Entidade', sql.NVarChar(40), entidadeSafe)
      .input('Campo', sql.NVarChar(40), campoSafe)
      .input('Acao', sql.NVarChar(40), acaoSafe)
      .input('Ip', sql.NVarChar(64), audit.ip)
      .input('UserAgent', sql.NVarChar(400), audit.userAgent),
    `
      EXEC dbo.sp_Admin_AplicarAcaoEstadoEntidade
        @AdminId = @AdminId,
        @Entidade = @Entidade,
        @EntidadeId = @EntidadeId,
        @Campo = @Campo,
        @NovoValor = @NovoValor,
        @Acao = @Acao,
        @Ip = @Ip,
        @UserAgent = @UserAgent;
    `
  );

  if (!r.recordset?.[0]?.Afetadas) {
    throw new HttpError(404, `${entidade} não encontrado.`);
  }

  return id;
}

function normalizarStatusDocumento(status) {
  const s = String(status || '').trim();
  if (!STATUS_DOCUMENTO_VALIDOS.has(s)) {
    throw new HttpError(400, 'status inválido. Use: Aprovado, Reprovado ou Pendente.');
  }
  return s;
}

function extractSqlLocalDateTimeParts(value) {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
      hour: value.getUTCHours(),
      minute: value.getUTCMinutes(),
      second: value.getUTCSeconds(),
      millisecond: value.getUTCMilliseconds(),
    };
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw
    .replace(/Z$/i, '')
    .replace(/([+-]\d{2}:\d{2})$/, '')
    .replace(' ', 'T');

  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,7}))?/
  );
  if (!match) return null;

  const fraction = String(match[7] ?? '').padEnd(3, '0').slice(0, 3);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? '0'),
    millisecond: Number(fraction || '0'),
  };
}

function formatSqlLocalDateTime(value) {
  const parts = extractSqlLocalDateTimeParts(value);
  if (!parts) return null;

  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}.${pad3(parts.millisecond)}`;
}

function mapDocumentoFilaRow(row) {
  if (!row) return row;

  return {
    ...row,
    DataEnvio: formatSqlLocalDateTime(row.DataEnvio),
    DataValidacao: formatSqlLocalDateTime(row.DataValidacao),
  };
}

const adminService = {

  //  Dashboard Financeiro
  async dashboardFinanceiro(usuario) {
    const result = await queryWithContext(usuario, null, `
      SELECT
        Ano,
        Mes,
        Periodo,
        ReceitaBruta,
        DespesasTotais,
        Lucro_AnexoIII,
        Lucro_AnexoV,
        Margem_III,
        Margem_V,
        BreakEven,
        Enquadramento,
        MelhorAnexo,
        UltimaAtualizacao
      FROM analytics.vw_ResumoFinanceiroMensal;
    `);
    return result.recordset;
  },

  //  Lista de indicações (painel admin)
  // Se quiser no futuro filtrar por fisioterapeuta, podemos aceitar um parâmetro aqui.
  async listarIndicacoes(usuario, fisioterapeutaId = null) {
    const result = await queryWithContext(
      usuario,
      (request) => request.input('FisioterapeutaId', sql.Int, fisioterapeutaId ?? null),
      `
        EXEC dbo.sp_ConsultarIndicacoes
          @FisioterapeutaId = @FisioterapeutaId;
      `
    );

    return result.recordset;
  },

  //  Documentos para validação
  async documentosPendentes(usuario, opcoes = {}) {
    const limitNum  = Math.min(Math.max(Number(opcoes?.limit)  || 20, 1), 100);
    const offsetNum = Math.max(Number(opcoes?.offset) || 0, 0);
    const status    = opcoes?.status ? String(opcoes.status).trim() : null;
    const busca     = opcoes?.busca  ? String(opcoes.busca).trim()  : null;

    const result = await queryWithContext(
      usuario,
      (request) => request
        .input('Status', sql.NVarChar(20),  status)
        .input('Busca',  sql.NVarChar(200), busca ? `%${busca}%` : null)
        .input('Limit',  sql.Int,           limitNum)
        .input('Offset', sql.Int,           offsetNum),
      `
        SELECT
          d.Id,
          d.FisioterapeutaId,
          d.NomeFisioterapeuta,
          d.TipoDocumento,
          d.Status,
          d.DataEnvio,
          d.DataValidacao,
          d.CaminhoArquivo,
          d.MotivoRejeicao,
          d.FonteValidacao,
          d.StatusVisual,
          f.Estado AS FisioterapeutaEstado,
          f.CREFITO AS FisioterapeutaCrefito,
          COUNT(*) OVER() AS Total
        FROM analytics.vw_FisioDocumentosValidacao d
        LEFT JOIN dbo.Fisioterapeutas f ON f.Id = d.FisioterapeutaId
        WHERE
          (@Status IS NULL OR d.Status = @Status)
          AND (@Busca IS NULL OR (
            d.NomeFisioterapeuta LIKE @Busca
            OR d.TipoDocumento   LIKE @Busca
            OR d.CaminhoArquivo  LIKE @Busca
            OR f.CREFITO         LIKE @Busca
          ))
        ORDER BY
          CASE d.Status
            WHEN N'Pendente'     THEN 1
            WHEN N'Desconhecido' THEN 2
            WHEN N'Reprovado'    THEN 3
            WHEN N'Aprovado'     THEN 4
            ELSE 5
          END,
          CASE WHEN d.DataEnvio IS NULL THEN 1 ELSE 0 END,
          d.DataEnvio ASC
        OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `
    );

    const rows  = result.recordset || [];
    const total = rows[0]?.Total ?? 0;
    const itens = rows.map(({ Total: _, ...rest }) => rest).map(mapDocumentoFilaRow);
    return { itens, total };
  },

  // -------------------------------------------------------------
  //  BLOQUEIO / DESBLOQUEIO / ATIVAÇÃO / DESATIVAÇÃO
  // -------------------------------------------------------------
  async listarAuditoriaAcoesAdmin(usuario, filtros = {}) {
    const { limit, offset } = normalizeLimitOffset(filtros?.limit, filtros?.offset);

    const adminId = filtros?.adminId == null || String(filtros.adminId).trim() === ''
      ? null
      : assertId(filtros.adminId, 'AdminId');

    const entidadeRaw = filtros?.entidade == null ? '' : String(filtros.entidade).trim();
    const entidade = entidadeRaw || null;
    if (entidade && !ENTIDADES_AUDITORIA_VALIDAS.has(entidade)) {
      throw new HttpError(400, 'Entidade inválida. Use: Fisioterapeuta ou Paciente.');
    }

    const entidadeId = filtros?.entidadeId == null || String(filtros.entidadeId).trim() === ''
      ? null
      : assertId(filtros.entidadeId, 'EntidadeId');

    const acaoRaw = filtros?.acao == null ? '' : String(filtros.acao).trim();
    const acao = acaoRaw || null;
    if (acao && !ACOES_AUDITORIA_VALIDAS.has(acao)) {
      throw new HttpError(400, 'Ação inválida. Use: Bloquear, Desbloquear, Ativar ou Desativar.');
    }

    const r = await queryWithContext(
      usuario,
      (request) => request
        .input('AdminId', sql.Int, adminId)
        .input('Entidade', sql.NVarChar(40), entidade)
        .input('EntidadeId', sql.Int, entidadeId)
        .input('Acao', sql.NVarChar(40), acao)
        .input('Limit', sql.Int, limit)
        .input('Offset', sql.Int, offset),
      `
        SELECT
          aa.Id,
          aa.AdminId,
          adm.Nome AS AdminNome,
          aa.Entidade,
          aa.EntidadeId,
          aa.Acao,
          aa.ValorAnterior,
          aa.ValorNovo,
          aa.Motivo,
          aa.Origem,
          aa.Ip,
          aa.UserAgent,
          aa.CorrelationId,
          aa.CriadoEm,
          COUNT(*) OVER() AS Total
        FROM dbo.AuditoriaAcoesAdmin aa
        LEFT JOIN dbo.Administradores adm ON adm.Id = aa.AdminId
        WHERE (@AdminId IS NULL OR aa.AdminId = @AdminId)
          AND (@Entidade IS NULL OR aa.Entidade = @Entidade)
          AND (@EntidadeId IS NULL OR aa.EntidadeId = @EntidadeId)
          AND (@Acao IS NULL OR aa.Acao = @Acao)
        ORDER BY aa.CriadoEm DESC, aa.Id DESC
        OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `
    );

    const rows = r.recordset || [];
    const total = rows[0]?.Total ?? 0;
    const itens = rows.map(({ Total: _unused, ...rest }) => rest);

    return { itens, total };
  },

  async listarFisioterapeutas(usuario, { busca, status, limit = 20, offset = 0 } = {}) {
    const limitNum  = Math.min(Math.max(Number(limit)  || 20, 1), 100);
    const offsetNum = Math.max(Number(offset) || 0, 0);
    const buscaCnpj = busca ? normalizeCNPJ(busca) : '';

    const r = await queryWithContext(
      usuario,
      (req) => req
        .input('Busca',   sql.NVarChar(200), busca  ? `%${busca}%` : null)
        .input('BuscaCnpj', sql.NVarChar(20), buscaCnpj ? `%${buscaCnpj}%` : null)
        .input('Status',  sql.NVarChar(20),  status || null)
        .input('Limit',   sql.Int,           limitNum)
        .input('Offset',  sql.Int,           offsetNum),
      `
        SELECT
          f.Id,
          f.Nome,
          f.CREFITO               AS Crefito,
          f.Email,
          f.Telefone,
          f.CNPJ,
          f.Ativo,
          f.IsBloqueado           AS Bloqueado,
          f.LinkVideoApresentacao AS LinkVideo,
          f.DataCadastro          AS CriadoEm,
          COUNT(*) OVER()         AS Total
        FROM dbo.Fisioterapeutas f
        WHERE
          (@Busca IS NULL OR (
            f.Nome      LIKE @Busca OR
            f.Email     LIKE @Busca OR
            f.CREFITO   LIKE @Busca OR
            f.CNPJ      LIKE @Busca OR
            (@BuscaCnpj IS NOT NULL AND f.CNPJ LIKE @BuscaCnpj) OR
            f.Telefone  LIKE @Busca
          ))
          AND (@Status IS NULL
            OR (@Status = 'ativo'     AND f.Ativo = 1 AND f.IsBloqueado = 0)
            OR (@Status = 'inativo'   AND f.Ativo = 0)
            OR (@Status = 'bloqueado' AND f.IsBloqueado = 1)
          )
        ORDER BY f.Nome ASC
        OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `,
      { requireContext: true }
    );

    const rows = r.recordset || [];
    const total = rows[0]?.Total ?? 0;
    const itens = rows.map(({ Total: _, ...rest }) => rest);
    return { itens, total };
  },

  async bloquearFisioterapeuta(usuario, id, auditMeta = {}) {
    const fisioId = await aplicarAcaoEstadoEntidade(usuario, {
      entidade: 'Fisioterapeuta',
      entidadeId: id,
      acao: 'Bloquear',
      campo: 'IsBloqueado',
      novoValor: 1,
      auditMeta
    });
    return `Fisioterapeuta ${fisioId} bloqueado com sucesso.`;
  },

  async desbloquearFisioterapeuta(usuario, id, auditMeta = {}) {
    const fisioId = await aplicarAcaoEstadoEntidade(usuario, {
      entidade: 'Fisioterapeuta',
      entidadeId: id,
      acao: 'Desbloquear',
      campo: 'IsBloqueado',
      novoValor: 0,
      auditMeta
    });
    return `Fisioterapeuta ${fisioId} desbloqueado com sucesso.`;
  },

  async ativarFisioterapeuta(usuario, id, auditMeta = {}) {
    const fisioId = await aplicarAcaoEstadoEntidade(usuario, {
      entidade: 'Fisioterapeuta',
      entidadeId: id,
      acao: 'Ativar',
      campo: 'Ativo',
      novoValor: 1,
      auditMeta
    });
    return `Fisioterapeuta ${fisioId} ativado.`;
  },

  async desativarFisioterapeuta(usuario, id, auditMeta = {}) {
    const fisioId = await aplicarAcaoEstadoEntidade(usuario, {
      entidade: 'Fisioterapeuta',
      entidadeId: id,
      acao: 'Desativar',
      campo: 'Ativo',
      novoValor: 0,
      auditMeta
    });
    return `Fisioterapeuta ${fisioId} desativado.`;
  },

  async listarPacientes(usuario, { busca, status, limit = 20, offset = 0 } = {}) {
    const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const offsetNum = Math.max(Number(offset) || 0, 0);

    const r = await queryWithContext(
      usuario,
      (req) => req
        .input('Busca', sql.NVarChar(200), busca ? `%${busca}%` : null)
        .input('Status', sql.NVarChar(20), status || null)
        .input('Limit', sql.Int, limitNum)
        .input('Offset', sql.Int, offsetNum),
      `
        SELECT
          p.Id,
          p.Nome,
          p.Email,
          p.Telefone,
          ISNULL(p.Ativo, 0)       AS Ativo,
          ISNULL(p.IsBloqueado, 0) AS Bloqueado,
          p.DataCadastro           AS CriadoEm,
          COUNT(*) OVER()          AS Total
        FROM dbo.Pacientes p
        WHERE
          (@Busca IS NULL OR (
            p.Nome     LIKE @Busca OR
            p.Email    LIKE @Busca OR
            p.Telefone LIKE @Busca OR
            p.CPF      LIKE @Busca
          ))
          AND (@Status IS NULL
            OR (@Status = 'ativo'     AND ISNULL(p.Ativo, 0) = 1 AND ISNULL(p.IsBloqueado, 0) = 0)
            OR (@Status = 'inativo'   AND ISNULL(p.Ativo, 0) = 0)
            OR (@Status = 'bloqueado' AND ISNULL(p.IsBloqueado, 0) = 1)
          )
        ORDER BY p.Nome ASC
        OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `,
      { requireContext: true }
    );

    const rows = r.recordset || [];
    const total = rows[0]?.Total ?? 0;
    const itens = rows.map(({ Total: _, ...rest }) => rest);
    return { itens, total };
  },

  // -------------------------------------------------------------
  //  BLOQUEIO / DESBLOQUEIO PACIENTES
  // -------------------------------------------------------------
  async bloquearPaciente(usuario, id, auditMeta = {}) {
    const pacienteId = await aplicarAcaoEstadoEntidade(usuario, {
      entidade: 'Paciente',
      entidadeId: id,
      acao: 'Bloquear',
      campo: 'IsBloqueado',
      novoValor: 1,
      auditMeta
    });
    return `Paciente ${pacienteId} bloqueado com sucesso.`;
  },

  async desbloquearPaciente(usuario, id, auditMeta = {}) {
    const pacienteId = await aplicarAcaoEstadoEntidade(usuario, {
      entidade: 'Paciente',
      entidadeId: id,
      acao: 'Desbloquear',
      campo: 'IsBloqueado',
      novoValor: 0,
      auditMeta
    });
    return `Paciente ${pacienteId} desbloqueado com sucesso.`;
  },

  async desativarPaciente(usuario, id, auditMeta = {}) {
    const pacienteId = await aplicarAcaoEstadoEntidade(usuario, {
      entidade: 'Paciente',
      entidadeId: id,
      acao: 'Desativar',
      campo: 'Ativo',
      novoValor: 0,
      auditMeta
    });
    return `Paciente ${pacienteId} desativado com sucesso.`;
  },

  async ativarPaciente(usuario, id, auditMeta = {}) {
    const pacienteId = await aplicarAcaoEstadoEntidade(usuario, {
      entidade: 'Paciente',
      entidadeId: id,
      acao: 'Ativar',
      campo: 'Ativo',
      novoValor: 1,
      auditMeta
    });
    return `Paciente ${pacienteId} ativado com sucesso.`;
  },

  // -------------------------------------------------------------
  //  Vídeo de Apresentação – ADMIN define o link (YouTube etc.)
  // -------------------------------------------------------------
  async atualizarLinkVideoApresentacao(usuario, fisioterapeutaId, linkVideo) {
    const id = assertId(fisioterapeutaId, 'FisioterapeutaId');
    const link = String(linkVideo || '').trim();
    if (!YOUTUBE_RE.test(link)) {
      throw new HttpError(400, 'Link inválido. Use uma URL do YouTube.');
    }

    const r = await queryWithContext(
      usuario,
      (request) => request
        .input('Id', sql.Int, id)
        .input('LinkVideoApresentacao', sql.NVarChar(1000), link),
      `
        UPDATE dbo.Fisioterapeutas
        SET LinkVideoApresentacao = @LinkVideoApresentacao
        WHERE Id = @Id;
        DECLARE @Afetadas INT = @@ROWCOUNT;

        BEGIN TRY
          EXEC dbo.SP_RecalcularMetricasPublicasFisio @FisioterapeutaId = @Id;
        END TRY
        BEGIN CATCH
        END CATCH;

        SELECT @Afetadas AS Afetadas;
      `
    );
    if (!r.recordset?.[0]?.Afetadas) throw new HttpError(404, 'Fisioterapeuta não encontrado.');

    return `Link de vídeo do fisioterapeuta ${id} atualizado com sucesso.`;
  },

  // -------------------------------------------------------------
  //  Aprovar / Reprovar Documento
  // -------------------------------------------------------------
  async validarDocumento(usuario, documentoId, status, motivo, adminId) {
    const docId = assertId(documentoId, 'DocumentoId');
    const adminValidadorId = assertId(adminId, 'AdminId');
    const statusNorm = normalizarStatusDocumento(status);

    const docResult = await queryWithContext(
      usuario,
      (request) => request.input('Id', sql.Int, docId),
      `
        SELECT Id, FisioterapeutaId, TipoDocumento
        FROM dbo.DocumentosFisioterapeutas
        WHERE Id = @Id;
      `
    );

    const documento = docResult.recordset[0];
    if (!documento) throw new HttpError(404, 'Documento não encontrado.');

    if (documento.TipoDocumento === 'CREFITO') {
      return await this._validarDocumentoCrefito(usuario, documento, statusNorm, motivo, adminValidadorId);
    }

    return await this._validarDocumentoGenerico(usuario, documento, statusNorm, motivo, adminValidadorId);
  },

  // 📎 Download
  async downloadDocumento(usuario, id) {
    const docId = assertId(id, 'DocumentoId');
    const result = await queryWithContext(
      usuario,
      (request) => request.input('Id', sql.Int, docId),
      `
        SELECT CaminhoArquivo 
        FROM dbo.DocumentosFisioterapeutas 
        WHERE Id = @Id;
      `
    );

    const row = result.recordset[0];
    if (!row) throw new HttpError(404, 'Documento não encontrado.');

    const caminho = String(row.CaminhoArquivo || '').trim();
    if (!caminho) {
      throw new HttpError(404, 'Documento não possui caminho de arquivo.');
    }

    const uploadsRoot = path.resolve('uploads');
    if (path.isAbsolute(caminho)) {
      throw new HttpError(400, 'Caminho absoluto não é permitido. Use caminho relativo em uploads/.');
    }

    // Normaliza barras, remove barras iniciais e eventual prefixo "uploads/"
    const relativo = caminho
      .replace(/^[\\/]+/, '')
      .replace(/\\/g, '/')
      .replace(/^uploads\//i, '');

    const caminhoFisico = path.resolve(uploadsRoot, relativo);
    const relativoParaRoot = path.relative(uploadsRoot, caminhoFisico);
    if (relativoParaRoot.startsWith('..') || path.isAbsolute(relativoParaRoot)) {
      throw new HttpError(400, 'Caminho de arquivo inválido.');
    }

    try {
      await fs.promises.access(caminhoFisico, fs.constants.F_OK);
    } catch {
      throw new HttpError(404, 'Arquivo não existe no servidor.');
    }

    return caminhoFisico;
  },

  // -------------------------------------------------------------
  // Assinaturas Premium
  // -------------------------------------------------------------
  async listarAssinaturas(usuario) {
    const result = await queryWithContext(usuario, null, `
      SELECT
        Id,
        NomePlano,
        ValorAtual,
        Ativo,
        DataInicio,
        DataAtualizacao,
        UsuarioUltimaAlteracao,
        DiasEmVigor,
        UltimaAlteracao,
        StatusDescricao
      FROM dbo.vw_AssinaturaPremiumAtual;
    `);
    return result.recordset[0];
  },

  async atualizarAssinaturas(usuario, dados, usuarioUltimaAlteracao) {
    const valorMensal = assertValorPositivo(dados?.ValorMensal, 'ValorMensal');
    const r = await queryWithContext(
      usuario,
      (request) => request
        .input('ValorMensal', sql.Decimal(10, 2), valorMensal)
        .input('UsuarioUltimaAlteracao', sql.NVarChar(200), usuarioUltimaAlteracao),
      `
        UPDATE dbo.ParametrosAssinaturas
        SET ValorMensal = @ValorMensal,
            UsuarioUltimaAlteracao = @UsuarioUltimaAlteracao,
            DataAtualizacao = SYSDATETIME()
        WHERE Ativo = 1;
        SELECT @@ROWCOUNT AS Afetadas;
      `
    );
    if (!r.recordset?.[0]?.Afetadas) throw new HttpError(404, 'Parâmetro de assinatura ativo não encontrado.');
  },

  // -------------------------------------------------------------
  //  Parâmetros Financeiros (Pró-Labore / DARF)
  // -------------------------------------------------------------
  async listarParametrosFinanceiros(usuario, periodo) {
    const periodoCalculo = periodo == null ? null : String(periodo).trim();
    if (periodoCalculo && !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodoCalculo)) {
      throw new HttpError(400, 'Periodo inválido. Use o formato YYYY-MM.');
    }

    const result = await queryWithContext(usuario, (request) => request.input('PeriodoCalculo', sql.VarChar(7), periodoCalculo), `
      DECLARE @PeriodoRef CHAR(7) = COALESCE(CONVERT(CHAR(7), @PeriodoCalculo), CONVERT(CHAR(7), SYSDATETIME(), 120));
      DECLARE @DataRef DATE = CONVERT(DATE, CONCAT(@PeriodoRef, '-01'));

      ;WITH ParametroVigente AS (
        SELECT TOP (1)
          pf.ProLaborePercentual,
          pf.AliquotaAnexoIII,
          pf.AliquotaAnexoV,
          pf.DataInicio
        FROM dbo.ParametrosFinanceiros pf
        WHERE ISNULL(pf.Ativo, 1) = 1
        ORDER BY
          CASE
            WHEN pf.DataInicio IS NULL OR CAST(pf.DataInicio AS DATE) <= @DataRef THEN 0
            ELSE 1
          END ASC,
          CASE
            WHEN pf.DataInicio IS NULL OR CAST(pf.DataInicio AS DATE) <= @DataRef THEN pf.DataInicio
            ELSE NULL
          END DESC,
          CASE
            WHEN pf.DataInicio IS NOT NULL AND CAST(pf.DataInicio AS DATE) > @DataRef THEN pf.DataInicio
            ELSE NULL
          END ASC,
          pf.Id DESC
      )
      SELECT TOP 1
        pf.ProLaborePercentual,
        pf.AliquotaAnexoIII,
        pf.AliquotaAnexoV,
        pf.DataInicio AS DataAtualizacao,
        @PeriodoRef AS PeriodoCalculo,
        ISNULL(dg.ReceitaBruta, 0) AS ReceitaBrutaMesAtual,
        CAST(ROUND(ISNULL(dg.ReceitaBruta, 0) * (pf.ProLaborePercentual / 100.0), 2) AS DECIMAL(18,2)) AS ProLaboreValor,
        dbo.fn_CalcularDARF_Unificado(
          CAST(ROUND(ISNULL(dg.ReceitaBruta, 0) * (pf.ProLaborePercentual / 100.0), 2) AS DECIMAL(18,2))
        ) AS DARFValor
      FROM ParametroVigente pf
      OUTER APPLY (
        SELECT TOP 1 ReceitaBruta
        FROM cache.DashboardGerencial
        WHERE Periodo = @PeriodoRef
      ) dg;
    `);
    const row = result.recordset?.[0];
    if (!row) throw new HttpError(404, 'Parâmetros financeiros não configurados.');
    return row;
  },

  async atualizarParametrosFinanceiros(usuario, percentual) {
    const pct = assertValorPositivo(percentual, 'ProLaborePercentual');
    if (pct > 100) throw new HttpError(400, 'Percentual máximo: 100.');
    const r = await queryWithContext(
      usuario,
      (request) => request.input('ProLaborePercentual', sql.Decimal(10, 2), pct),
      `
        DECLARE @VigenciaInicio DATE = DATEFROMPARTS(YEAR(SYSDATETIME()), MONTH(SYSDATETIME()), 1);
        DECLARE @AliquotaAnexoIII DECIMAL(5,2);
        DECLARE @AliquotaAnexoV DECIMAL(5,2);
        DECLARE @ValorAssinaturaPremium DECIMAL(10,2);
        DECLARE @Enquadramento NVARCHAR(20) =
          CASE WHEN @ProLaborePercentual < 28 THEN N'ANEXO V' ELSE N'ANEXO III' END;
        DECLARE @LinhaMesId INT;

        SELECT TOP (1)
          @AliquotaAnexoIII = pf.AliquotaAnexoIII,
          @AliquotaAnexoV = pf.AliquotaAnexoV,
          @ValorAssinaturaPremium = pf.ValorAssinaturaPremium
        FROM dbo.ParametrosFinanceiros pf
        WHERE ISNULL(pf.Ativo, 1) = 1
        ORDER BY
          CASE
            WHEN pf.DataInicio IS NULL OR CAST(pf.DataInicio AS DATE) <= @VigenciaInicio THEN 0
            ELSE 1
          END ASC,
          CASE
            WHEN pf.DataInicio IS NULL OR CAST(pf.DataInicio AS DATE) <= @VigenciaInicio THEN pf.DataInicio
            ELSE NULL
          END DESC,
          CASE
            WHEN pf.DataInicio IS NOT NULL AND CAST(pf.DataInicio AS DATE) > @VigenciaInicio THEN pf.DataInicio
            ELSE NULL
          END ASC,
          pf.Id DESC;

        IF @AliquotaAnexoIII IS NULL OR @AliquotaAnexoV IS NULL
          THROW 51031, N'ParametrosFinanceiros ativo não encontrado para criar vigência de pró-labore.', 1;

        SELECT TOP (1) @LinhaMesId = pf.Id
        FROM dbo.ParametrosFinanceiros pf
        WHERE ISNULL(pf.Ativo, 1) = 1
          AND pf.DataInicio IS NOT NULL
          AND CAST(pf.DataInicio AS DATE) = @VigenciaInicio
        ORDER BY pf.Id DESC;

        IF @LinhaMesId IS NOT NULL
        BEGIN
          UPDATE dbo.ParametrosFinanceiros
          SET ProLaborePercentual = @ProLaborePercentual,
              Enquadramento = @Enquadramento,
              DataInicio = CAST(@VigenciaInicio AS DATETIME)
          WHERE Id = @LinhaMesId;
        END
        ELSE
        BEGIN
          INSERT INTO dbo.ParametrosFinanceiros
            (AliquotaAnexoIII, AliquotaAnexoV, ProLaborePercentual, Enquadramento, DataInicio, Ativo, ValorAssinaturaPremium)
          VALUES
            (@AliquotaAnexoIII, @AliquotaAnexoV, @ProLaborePercentual, @Enquadramento, CAST(@VigenciaInicio AS DATETIME), 1, @ValorAssinaturaPremium);
        END;

        SELECT 1 AS Afetadas;
      `
    );
    if (!r.recordset?.[0]?.Afetadas) throw new HttpError(404, 'ParametrosFinanceiros não encontrado.');
  },

  // -------------------------------------------------------------
  //  Parâmetros do Sistema
  // -------------------------------------------------------------
  async listarSistema(usuario) {
    const result = await queryWithContext(usuario, null, `
      SELECT
        Id,
        Nome,
        ValorDecimal,
        ValorTexto,
        Ativo,
        DataAtualizacao
      FROM vw_ParametrosSistema
      WHERE Nome IN ('ValorMinimoConsulta', 'RepasseTarifaPix', 'RepasseTarifaTed');
    `);

    const porNome = new Map((result.recordset || []).map((row) => [row.Nome, row]));
    const valorMinimoConsulta = porNome.get('ValorMinimoConsulta') || null;

    return {
      ...(valorMinimoConsulta || {}),
      ValorMinimoConsulta: valorMinimoConsulta,
      RepasseTarifaPix: porNome.get('RepasseTarifaPix') || null,
      RepasseTarifaTed: porNome.get('RepasseTarifaTed') || null,
    };
  },

  async atualizarSistema(usuario, dados = {}, usuarioUltimaAlteracao) {
    const hasOwn = (campo) => Object.prototype.hasOwnProperty.call(dados, campo);
    const valorMinimo = hasOwn('ValorMinimoConsulta')
      ? assertValorPositivo(dados.ValorMinimoConsulta, 'ValorMinimoConsulta')
      : null;
    const repasseTarifaPix = hasOwn('RepasseTarifaPix')
      ? assertValorPositivo(dados.RepasseTarifaPix, 'RepasseTarifaPix')
      : null;
    const repasseTarifaTed = hasOwn('RepasseTarifaTed')
      ? assertValorPositivo(dados.RepasseTarifaTed, 'RepasseTarifaTed')
      : null;

    const r = await queryWithContext(
      usuario,
      (request) => request
        .input('ValorMinimoConsulta', sql.Decimal(10, 2), valorMinimo)
        .input('RepasseTarifaPix', sql.Decimal(10, 2), repasseTarifaPix)
        .input('RepasseTarifaTed', sql.Decimal(10, 2), repasseTarifaTed),
      `
        DECLARE @Atualizacoes TABLE (
          Nome NVARCHAR(100) NOT NULL PRIMARY KEY,
          ValorDecimal DECIMAL(10, 2) NOT NULL
        );

        IF @ValorMinimoConsulta IS NOT NULL
          INSERT INTO @Atualizacoes (Nome, ValorDecimal)
          VALUES (N'ValorMinimoConsulta', @ValorMinimoConsulta);

        IF @RepasseTarifaPix IS NOT NULL
          INSERT INTO @Atualizacoes (Nome, ValorDecimal)
          VALUES (N'RepasseTarifaPix', @RepasseTarifaPix);

        IF @RepasseTarifaTed IS NOT NULL
          INSERT INTO @Atualizacoes (Nome, ValorDecimal)
          VALUES (N'RepasseTarifaTed', @RepasseTarifaTed);

        IF NOT EXISTS (SELECT 1 FROM @Atualizacoes)
          THROW 51041, N'Informe ao menos um parâmetro do sistema para atualização.', 1;

        DECLARE @Esperadas INT = (SELECT COUNT(*) FROM @Atualizacoes);

        UPDATE ps
        SET ps.ValorDecimal = a.ValorDecimal,
            ps.DataAtualizacao = SYSDATETIME()
        FROM dbo.ParametrosSistema ps
        INNER JOIN @Atualizacoes a ON a.Nome = ps.Nome
        WHERE ps.Ativo = 1;

        SELECT @Esperadas AS Esperadas, @@ROWCOUNT AS Afetadas;
      `
    );
    const row = r.recordset?.[0];
    if (!row?.Afetadas || Number(row.Afetadas) !== Number(row.Esperadas)) {
      throw new HttpError(404, 'Um ou mais parâmetros do sistema não foram encontrados.');
    }
  },

  // -------------------------------------------------------------
  //  Taxas
  // -------------------------------------------------------------
  async listarTaxas(usuario) {
    const result = await queryWithContext(usuario, null, `
      SELECT
        Id,
        Nome,
        Percentual,
        Tipo,
        DataInicio,
        Ativa,
        AdministradorId,
        ValorPercentual,
        DataFim,
        CriadoPor
      FROM vw_Taxas
      WHERE Ativa = 1;
    `);
    return result.recordset;
  },

  async atualizarTaxaPorId(usuario, id, percentual) {
    const taxaId = assertId(id, 'Id');
    const pct = assertValorPositivo(percentual, 'Percentual');
    if (pct > 100) throw new HttpError(400, 'Percentual máximo: 100.');
    const r = await queryWithContext(
      usuario,
      (request) => request
        .input('Id', sql.Int, taxaId)
        .input('Percentual', sql.Decimal(10, 2), pct),
      `
        UPDATE dbo.Taxas
        SET Percentual = @Percentual,
            DataInicio = SYSDATETIME()
        WHERE Id = @Id;
        SELECT @@ROWCOUNT AS Afetadas;
      `
    );
    if (!r.recordset?.[0]?.Afetadas) throw new HttpError(404, 'Taxa não encontrada.');
  },

  async listarGatewayPerfisCusto(usuario, incluirInativos = false) {
    const result = await queryWithContext(
      usuario,
      (request) => request.input('IncluirInativos', sql.Bit, Boolean(incluirInativos)),
      `
        SELECT
          Id,
          Nome,
          ContextoCalculo,
          MetodoPagamento,
          ParcelasMin,
          ParcelasMax,
          Percentual,
          ValorFixo,
          FixoPor,
          AnteciparAtivo,
          TaxaAntecipacaoMensal,
          PrazoDias,
          Ativo,
          DataInicio,
          DataFim,
          CriadoPor
        FROM dbo.vw_GatewayPerfisCusto
        WHERE @IncluirInativos = 1 OR Ativo = 1
        ORDER BY
          ContextoCalculo,
          MetodoPagamento,
          ParcelasMin,
          ParcelasMax,
          DataInicio DESC,
          Id DESC;
      `
    );
    return result.recordset || [];
  },

  async versionarGatewayPerfilCusto(usuario, dados) {
    const nome = String(dados?.Nome ?? dados?.nome ?? '').trim();
    const contexto = String(dados?.ContextoCalculo ?? dados?.contextoCalculo ?? '').trim();
    const metodoPagamentoRaw = dados?.MetodoPagamento ?? dados?.metodoPagamento ?? null;
    const metodoPagamento =
      metodoPagamentoRaw == null || String(metodoPagamentoRaw).trim() === ''
        ? null
        : String(metodoPagamentoRaw).trim();
    const parcelasMin = assertId(dados?.ParcelasMin ?? dados?.parcelasMin, 'ParcelasMin');
    const parcelasMax = assertId(dados?.ParcelasMax ?? dados?.parcelasMax, 'ParcelasMax');
    const percentual = assertValorPositivo(dados?.Percentual ?? dados?.percentual, 'Percentual');
    const valorFixo = Number(dados?.ValorFixo ?? dados?.valorFixo ?? 0);
    const fixoPor = String(dados?.FixoPor ?? dados?.fixoPor ?? 'transacao').trim();
    const anteciparAtivo = Boolean(dados?.AnteciparAtivo ?? dados?.anteciparAtivo ?? false);
    const taxaAntecipacaoMensalRaw = dados?.TaxaAntecipacaoMensal ?? dados?.taxaAntecipacaoMensal;
    const prazoDiasRaw = dados?.PrazoDias ?? dados?.prazoDias;

    if (!nome) throw new HttpError(400, 'Nome é obrigatório.');
    if (!['ConsultaAvulsa', 'Pacote'].includes(contexto)) {
      throw new HttpError(400, 'ContextoCalculo inválido.');
    }
    if (metodoPagamento != null && !['PIX', 'CartaoCredito'].includes(metodoPagamento)) {
      throw new HttpError(400, 'MetodoPagamento inválido.');
    }
    if (parcelasMax < parcelasMin) {
      throw new HttpError(400, 'ParcelasMax deve ser maior ou igual a ParcelasMin.');
    }
    if (percentual > 100) throw new HttpError(400, 'Percentual máximo: 100.');
    if (!Number.isFinite(valorFixo) || valorFixo < 0) {
      throw new HttpError(400, 'ValorFixo inválido.');
    }
    if (!['transacao', 'parcela'].includes(fixoPor)) {
      throw new HttpError(400, 'FixoPor inválido.');
    }

    const taxaAntecipacaoMensal =
      taxaAntecipacaoMensalRaw == null || taxaAntecipacaoMensalRaw === ''
        ? null
        : Number(taxaAntecipacaoMensalRaw);
    const prazoDias =
      prazoDiasRaw == null || prazoDiasRaw === ''
        ? null
        : Number(prazoDiasRaw);

    if (taxaAntecipacaoMensal != null && (!Number.isFinite(taxaAntecipacaoMensal) || taxaAntecipacaoMensal < 0)) {
      throw new HttpError(400, 'TaxaAntecipacaoMensal inválida.');
    }
    if (prazoDias != null && (!Number.isInteger(prazoDias) || prazoDias < 0)) {
      throw new HttpError(400, 'PrazoDias inválido.');
    }

    const result = await queryWithContext(
      usuario,
      (request) => request
        .input('Nome', sql.NVarChar(120), nome)
        .input('ContextoCalculo', sql.NVarChar(30), contexto)
        .input('MetodoPagamento', sql.NVarChar(30), metodoPagamento)
        .input('ParcelasMin', sql.TinyInt, parcelasMin)
        .input('ParcelasMax', sql.TinyInt, parcelasMax)
        .input('Percentual', sql.Decimal(10, 4), percentual)
        .input('ValorFixo', sql.Decimal(10, 4), valorFixo)
        .input('FixoPor', sql.NVarChar(20), fixoPor)
        .input('AnteciparAtivo', sql.Bit, anteciparAtivo)
        .input('TaxaAntecipacaoMensal', sql.Decimal(10, 4), taxaAntecipacaoMensal)
        .input('PrazoDias', sql.SmallInt, prazoDias)
        .input('CriadoPor', sql.NVarChar(100), usuario?.nome || usuario?.email || 'admin'),
      `
        DECLARE @Novo TABLE (GatewayPerfilCustoId INT);

        INSERT INTO @Novo (GatewayPerfilCustoId)
        EXEC dbo.SP_GatewayPerfisCusto_Versionar
          @Nome = @Nome,
          @ContextoCalculo = @ContextoCalculo,
          @MetodoPagamento = @MetodoPagamento,
          @ParcelasMin = @ParcelasMin,
          @ParcelasMax = @ParcelasMax,
          @Percentual = @Percentual,
          @ValorFixo = @ValorFixo,
          @FixoPor = @FixoPor,
          @AnteciparAtivo = @AnteciparAtivo,
          @TaxaAntecipacaoMensal = @TaxaAntecipacaoMensal,
          @PrazoDias = @PrazoDias,
          @CriadoPor = @CriadoPor;

        SELECT TOP (1) v.*
        FROM dbo.vw_GatewayPerfisCusto v
        JOIN @Novo n ON n.GatewayPerfilCustoId = v.Id;
      `
    );
    return result.recordset?.[0] || null;
  },

  async encerrarGatewayPerfilCusto(usuario, id) {
    const perfilId = assertId(id, 'Id');
    const result = await queryWithContext(
      usuario,
      (request) => request
        .input('Id', sql.Int, perfilId)
        .input('CriadoPor', sql.NVarChar(100), usuario?.nome || usuario?.email || 'admin'),
      `
        EXEC dbo.SP_GatewayPerfisCusto_Encerrar
          @GatewayPerfilCustoId = @Id,
          @AtualizadoPor = @CriadoPor;

        SELECT TOP (1) *
        FROM dbo.vw_GatewayPerfisCusto
        WHERE Id = @Id;
      `
    );
    return result.recordsets?.[1]?.[0] || result.recordset?.[0] || null;
  },

  // -------------------------------------------------------------
  //  Pontuação
  // -------------------------------------------------------------
  async listarPontuacaoRegras(usuario) {
    const regras = await queryWithContext(usuario, null, `
      SELECT
        Id,
        Acao,
        Pontos,
        Descricao,
        Ativo,
        DataAtualizacao
      FROM vw_PontuacaoRegras;
    `);
    return regras.recordset || [];
  },

  async listarPontuacaoEventos(usuario) {
    const eventos = await queryWithContext(usuario, null, `
      SELECT
        Id,
        Evento,
        Descricao,
        Pontos,
        Ativo,
        DataCriacao,
        UsuarioCriacao
      FROM vw_PontuacoesEventos;
    `);
    return eventos.recordset || [];
  },

  async listarPontuacaoCompleta(usuario) {
    const [regras, eventos] = await Promise.all([
      this.listarPontuacaoRegras(usuario),
      this.listarPontuacaoEventos(usuario),
    ]);

    return {
      regras,
      eventos
    };
  },

  async atualizarPontuacaoRegra(usuario, id, pontos) {
    const regraId = assertId(id, 'Id');
    const r = await queryWithContext(
      usuario,
      (request) => request
        .input('Id', sql.Int, regraId)
        .input('Pontos', sql.Int, pontos),
      `
        UPDATE dbo.PontuacaoRegras
        SET Pontos = @Pontos,
            DataAtualizacao = SYSDATETIME()
        WHERE Id = @Id;
        SELECT @@ROWCOUNT AS Afetadas;
      `
    );
    if (!r.recordset?.[0]?.Afetadas) throw new HttpError(404, 'Regra de pontuação não encontrada.');
  },

  async atualizarPontuacaoEvento(usuario, id, pontos) {
    const eventoId = assertId(id, 'Id');
    const r = await queryWithContext(
      usuario,
      (request) => request
        .input('Id', sql.Int, eventoId)
        .input('Pontos', sql.Int, pontos),
      `
        UPDATE dbo.PontuacoesEventos
        SET Pontos = @Pontos
        WHERE Id = @Id;
        SELECT @@ROWCOUNT AS Afetadas;
      `
    );
    if (!r.recordset?.[0]?.Afetadas) throw new HttpError(404, 'Evento de pontuação não encontrado.');
  },

  // -------------------------------------------------------------
  //  MÉTODOS INTERNOS – VALIDAÇÃO DOCUMENTAL
  // -------------------------------------------------------------
  async _validarDocumentoGenerico(usuario, documento, status, motivo, adminId) {
    const r = await queryWithContext(
      usuario,
      (request) => request
        .input('Id', sql.Int, documento.Id)
        .input('Status', sql.NVarChar(20), status)
        .input('Motivo', sql.NVarChar(500), motivo || null)
        .input('ValidadorId', sql.Int, adminId),
      `
        UPDATE dbo.DocumentosFisioterapeutas
        SET Status        = @Status,
            MotivoRejeicao = @Motivo,
            ValidadorId   = @ValidadorId,
            DataValidacao = SYSDATETIME()
        WHERE Id = @Id;
        SELECT @@ROWCOUNT AS Afetadas;
      `
    );
    if (!r.recordset?.[0]?.Afetadas) throw new HttpError(404, 'Documento não encontrado.');

    return `Documento ${documento.Id} (${documento.TipoDocumento}) marcado como ${status}.`;
  },

  async _validarDocumentoCrefito(usuario, documento, status, motivo, adminId) {
    const fisioId = documento.FisioterapeutaId;

    if (status === 'Reprovado' && !motivo)
      throw new HttpError(400, 'Motivo de reprovação é obrigatório para CREFITO.');

    if (status === 'Aprovado') {
      await queryWithContext(
        usuario,
        (request) => request
          .input('Id', sql.Int, documento.Id)
          .input('Status', sql.NVarChar(20), 'Aprovado')
          .input('ValidadorId', sql.Int, adminId)
          .input('FisioId', sql.Int, fisioId),
        `
          BEGIN TRY
            BEGIN TRAN;

            UPDATE dbo.DocumentosFisioterapeutas
            SET Status         = @Status,
                MotivoRejeicao = NULL,
                ValidadorId    = @ValidadorId,
                DataValidacao  = SYSDATETIME(),
                FonteValidacao = 'Validação Manual',
                ScoreConfianca = 100
            WHERE Id = @Id;

            IF @@ROWCOUNT = 0
              THROW 50001, 'Documento não encontrado.', 1;

            UPDATE dbo.Fisioterapeutas
            SET CrefitoVerificado = 1,
                DataVerificacao   = SYSDATETIME(),
                FonteVerificacao  = 'Validação Manual'
            WHERE Id = @FisioId;

            IF @@ROWCOUNT = 0
              THROW 50002, 'Fisioterapeuta não encontrado.', 1;

            COMMIT;
          END TRY
          BEGIN CATCH
            IF @@TRANCOUNT > 0 ROLLBACK;
            THROW;
          END CATCH
        `
      );

      // Melhor esforço: indicação não pode bloquear aprovação de CREFITO.
      let mensagemIndicacao = 'Indicação aprovada (quando existente).';
      try {
        await queryWithContext(
          usuario,
          (request) => request.input('FisioId', sql.Int, fisioId),
          `EXEC sp_AprovarIndicacao @IndicadoId = @FisioId;`
        );
      } catch (err) {
        const msg = String(err?.message || '').toLowerCase();
        const semIndicacao =
          msg.includes('nenhuma indicação pendente encontrada') ||
          msg.includes('nenhuma indicacao pendente encontrada');

        if (semIndicacao) {
          mensagemIndicacao = 'Nenhuma indicação pendente encontrada.';
        } else {
          mensagemIndicacao = 'Não foi possível atualizar a indicação automaticamente.';
        }
      }

      void notificacoesDispatch.crefitoAprovado({ fisioterapeutaId: fisioId });

      if (mensagemIndicacao === 'Nenhuma indicação pendente encontrada.') {
        return `CREFITO do fisioterapeuta ${fisioId} aprovado com sucesso. Nenhuma indicação pendente encontrada.`;
      }
      if (mensagemIndicacao === 'Indicação aprovada (quando existente).') {
        return `CREFITO do fisioterapeuta ${fisioId} aprovado com sucesso. Indicação aprovada (quando existente).`;
      }
      return `CREFITO do fisioterapeuta ${fisioId} aprovado com sucesso. Não foi possível atualizar a indicação automaticamente.`;
    }

    if (status === 'Reprovado') {
      await queryWithContext(
        usuario,
        (request) => request
          .input('Id', sql.Int, documento.Id)
          .input('Status', sql.NVarChar(20), 'Reprovado')
          .input('Motivo', sql.NVarChar(500), motivo)
          .input('ValidadorId', sql.Int, adminId)
          .input('FisioId', sql.Int, fisioId),
        `
          BEGIN TRY
            BEGIN TRAN;

            UPDATE dbo.DocumentosFisioterapeutas
            SET Status         = @Status,
                MotivoRejeicao = @Motivo,
                ValidadorId    = @ValidadorId,
                DataValidacao  = SYSDATETIME()
            WHERE Id = @Id;

            IF @@ROWCOUNT = 0
              THROW 50001, 'Documento não encontrado.', 1;

            UPDATE dbo.Fisioterapeutas
            SET CrefitoVerificado = 0,
                FonteVerificacao  = 'Reprovado Manualmente'
            WHERE Id = @FisioId;

            IF @@ROWCOUNT = 0
              THROW 50002, 'Fisioterapeuta não encontrado.', 1;

            COMMIT;
          END TRY
          BEGIN CATCH
            IF @@TRANCOUNT > 0 ROLLBACK;
            THROW;
          END CATCH
        `
      );

      return `CREFITO do fisioterapeuta ${fisioId} reprovado.`;
    }

    // Outros status (ex.: voltar para Pendente, etc.)
    const r = await queryWithContext(
      usuario,
      (request) => request
        .input('Id', sql.Int, documento.Id)
        .input('Status', sql.NVarChar(20), status)
        .input('Motivo', sql.NVarChar(500), motivo || null)
        .input('ValidadorId', sql.Int, adminId),
      `
        UPDATE dbo.DocumentosFisioterapeutas
        SET Status         = @Status,
            MotivoRejeicao = @Motivo,
            ValidadorId    = @ValidadorId,
            DataValidacao = SYSDATETIME()
        WHERE Id = @Id;
        SELECT @@ROWCOUNT AS Afetadas;
      `
    );
    if (!r.recordset?.[0]?.Afetadas) throw new HttpError(404, 'Documento não encontrado.');

    return `Documento CREFITO ${documento.Id} atualizado para status ${status}.`;
  }

};

export default adminService;
