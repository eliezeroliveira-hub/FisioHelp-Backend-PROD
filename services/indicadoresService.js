// 📁 services/indicadoresService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

function isAdmin(usuario) {
  return String(usuario?.tipo || '').toLowerCase() === 'admin';
}

function isFisio(usuario) {
  return String(usuario?.tipo || '').toLowerCase() === 'fisioterapeuta';
}

function requireUser(usuario) {
  if (!usuario?.id || !usuario?.tipo) {
    throw new HttpError(401, 'Não autenticado.');
  }
}

function assertInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new HttpError(400, `${label} inválido.`);
  }
  return n;
}

/**
 * Monta um resumo agregado dos documentos do fisioterapeuta
 * por status, por tipo e score médio de confiança.
 */
function buildDocsResumo(docs = []) {
  const porStatus = {};
  const porTipo = {};
  let somaScore = 0;
  let qtdScore = 0;
  let ultimaData = null;

  for (const d of docs) {
    const st = String(d.Status || 'SemStatus');
    const tp = String(d.TipoDocumento || 'SemTipo');

    porStatus[st] = (porStatus[st] || 0) + 1;
    porTipo[tp] = (porTipo[tp] || 0) + 1;

    const sc = d.ScoreConfianca;
    if (sc !== null && sc !== undefined && !Number.isNaN(Number(sc))) {
      somaScore += Number(sc);
      qtdScore += 1;
    }

    const data = d.DataValidacao || d.DataEnvio || null;
    if (data) {
      const dt = new Date(data);
      if (!Number.isNaN(dt.getTime())) {
        if (!ultimaData || dt > ultimaData) {
          ultimaData = dt;
        }
      }
    }
  }

  return {
    total: docs.length,
    porStatus,
    porTipo,
    scoreMedio: qtdScore ? Number((somaScore / qtdScore).toFixed(2)) : null,
    ultimaAtualizacao: ultimaData ? ultimaData.toISOString() : null,
  };
}

/**
 * Converte um valor vindo do SQL (bit/int/bool) para flag 0/1.
 */
function to01(v) {
  return v === 1 || v === true ? 1 : 0;
}

function normalizeText(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function isCrefitoAprovadoNosDocumentos(docs = []) {
  return docs.some((d) => {
    const tipo = normalizeText(d?.TipoDocumento);
    const status = normalizeText(d?.Status);
    return tipo === 'crefito' && (status === 'aprovado' || status === 'validado');
  });
}

/**
 * Busca a confiabilidade do fisioterapeuta (CREFITO/Email/Telefone).
 * Mantém o mesmo estilo do endpoint do paciente (flags 0/1).
 */
async function obterConfiabilidadeFisio(usuario, fisioterapeutaId) {
  const res = await queryWithContext(
    usuario,
    (req) => req.input('Id', sql.Int, fisioterapeutaId),
    `
      SELECT TOP 1
        f.Id AS FisioterapeutaId,
        ISNULL(f.CrefitoVerificado, 0) AS CrefitoVerificado,
        ISNULL(f.EmailVerificado, 0) AS EmailVerificado,
        ISNULL(f.TelefoneVerificado, 0) AS TelefoneVerificado
      FROM dbo.Fisioterapeutas AS f
      WHERE f.Id = @Id;
    `
  );

  const row = res.recordset?.[0] || null;
  if (!row) return null;

  const crefitoValido = to01(row.CrefitoVerificado);
  const emailVerificado = to01(row.EmailVerificado);
  const telefoneVerificado = to01(row.TelefoneVerificado);
  const confiavel = crefitoValido && emailVerificado && telefoneVerificado ? 1 : 0;

  return {
    fisioterapeutaId: row.FisioterapeutaId,
    // Mantém nomenclatura “valido” (semântica igual a cpfValido)
    crefitoValido,
    emailVerificado,
    telefoneVerificado,
    confiavel,
  };
}

const indicadoresService = {
  /**
   * GET /fisio/indicadores
   * - Fisioterapeuta: sempre usa o próprio ID
   * - Admin: pode passar ?fisioterapeutaId=123 (opcional)
   */
  async obterIndicadores(usuario, { fisioterapeutaId } = {}) {
    requireUser(usuario);

    let fid;
    if (isAdmin(usuario)) {
      // Admin pode inspecionar outro fisioterapeuta via querystring,
      // senão cai no próprio id (mantendo compatibilidade)
      fid = fisioterapeutaId
        ? assertInt(fisioterapeutaId, 'fisioterapeutaId')
        : assertInt(usuario.id, 'Usuário');
    } else {
      if (!isFisio(usuario)) {
        throw new HttpError(403, 'Acesso negado.');
      }
      fid = assertInt(usuario.id, 'Usuário');
    }

    const [docsRes, confiabilidadeRes, metricsRes, cacheRankRes, avalResumoRes] = await Promise.all([
      // 1) Documentos (status/confiabilidade)
      queryWithContext(
        usuario,
        (req) => req.input('FisioterapeutaId', sql.Int, fid),
        `
        SELECT
          Id,
          FisioterapeutaId,
          NomeFisioterapeuta,
          TipoDocumento,
          CaminhoArquivo,
          Status,
          DataEnvio,
          DataValidacao,
          MotivoRejeicao,
          ScoreConfianca
        FROM dbo.vw_DocumentosFisioterapeutas
        WHERE FisioterapeutaId = @FisioterapeutaId
        ORDER BY ISNULL(DataValidacao, DataEnvio) DESC, Id DESC;
        `
      ),
      // 1.1) Confiabilidade (CREFITO/Email/Telefone)
      obterConfiabilidadeFisio(usuario, fid),
      // 2) Métricas (privado)
      queryWithContext(
        usuario,
        (req) => req.input('FisioterapeutaId', sql.Int, fid),
        `
        SELECT TOP 1
          FisioterapeutaId,
          Formacoes,
          TotalAtendimentos,
          MediaAvaliacoes,
          TotalAvaliacoes
        FROM dbo.vw_FisioterapeutaMetricsPrivado
        WHERE FisioterapeutaId = @FisioterapeutaId;
        `
      ),
      // 3) Ranking (preferir cache, senão view pública)
      queryWithContext(
        usuario,
        (req) => req.input('FisioterapeutaId', sql.Int, fid),
        `
        SELECT TOP 1
          FisioterapeutaId,
          Nome,
          Cidade,
          Estado,
          ValorConsultaBase,
          DescontoPacote,
          Reputacao,
          PontuacaoFinal,
          Categoria,
          Destaque,
          TotalConsultas,
          TotalAvaliacoes,
          MediaAvaliacoes,
          PosicaoRanking,
          DataAtualizacao
        FROM dbo.vw_FisioRankingPublico
        WHERE FisioterapeutaId = @FisioterapeutaId
        ORDER BY ISNULL(DataAtualizacao, GETDATE()) DESC;
        `
      ),
      // 4) Média/total de avaliações (mesma fonte do endpoint /me/avaliacoes/media)
      queryWithContext(
        usuario,
        (req) => req.input('FisioterapeutaId', sql.Int, fid),
        `
        SELECT TOP 1
          FisioterapeutaId,
          MediaNota,
          TotalAvaliacoes,
          UltimaAvaliacao,
          AtualizadoEm
        FROM analytics.vw_FisioAvaliacoesMedia
        WHERE FisioterapeutaId = @FisioterapeutaId;
        `
      )
    ]);

    const documentos = docsRes.recordset || [];
    const documentosResumo = buildDocsResumo(documentos);

    const confiabilidade = confiabilidadeRes || {
      fisioterapeutaId: fid,
      crefitoValido: 0,
      emailVerificado: 0,
      telefoneVerificado: 0,
      confiavel: 0,
    };

    // Fonte de verdade para CREFITO: status do documento.
    // Se houver CREFITO aprovado/validado, força como válido no dashboard.
    if (isCrefitoAprovadoNosDocumentos(documentos)) {
      confiabilidade.crefitoValido = 1;
      confiabilidade.confiavel =
        Number(confiabilidade.crefitoValido) === 1 &&
        Number(confiabilidade.emailVerificado) === 1 &&
        Number(confiabilidade.telefoneVerificado) === 1
          ? 1
          : 0;
    }

    const metrics = metricsRes.recordset?.[0] || null;

    const reputacao = {
      totalAtendimentos: metrics?.TotalAtendimentos ?? 0,
      mediaAvaliacoes: metrics?.MediaAvaliacoes ?? 0,
      totalAvaliacoes: metrics?.TotalAvaliacoes ?? 0,
      formacoes: metrics?.Formacoes ?? null,
      // Se no futuro você incluir datas na view, pode preencher aqui:
      ultimaAvaliacao: null,
      atualizadoEm: null,
    };

    let ranking = cacheRankRes.recordset?.[0] || null;
    const avalResumo = avalResumoRes.recordset?.[0] || null;

    const rankingDto = ranking
      ? {
          posicaoRanking: ranking.PosicaoRanking ?? null,
          pontuacaoFinal: ranking.PontuacaoFinal ?? null,
          reputacao: ranking.Reputacao ?? null,
          categoria: ranking.Categoria ?? null,
          destaque: ranking.Destaque ?? null,
          totalConsultas: ranking.TotalConsultas ?? null,
          totalAvaliacoes: avalResumo?.TotalAvaliacoes ?? ranking.TotalAvaliacoes ?? null,
          mediaAvaliacoes: avalResumo?.MediaNota ?? ranking.MediaAvaliacoes ?? null,
          atualizadoEm: ranking.DataAtualizacao
            ? new Date(ranking.DataAtualizacao).toISOString()
            : null,
        }
      : null;

    return {
      fisioterapeutaId: fid,
      confiabilidade,

      // ✅ Formato final (limpo) — como você pediu:
      // documentos: { resumo, itens }
      documentos: {
        resumo: documentosResumo,
        itens: documentos,
      },

      reputacao,
      ranking: rankingDto,
    };
  },
};

export { HttpError };
export default indicadoresService;
