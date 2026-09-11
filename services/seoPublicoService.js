import crypto from 'crypto';

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = null;

function texto(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function compararTexto(a, b) {
  return String(a).localeCompare(String(b), 'pt-BR', { sensitivity: 'base' });
}

export function montarCatalogoSeo(rows, geradoEm = new Date().toISOString()) {
  const perfis = new Map();

  for (const row of rows || []) {
    const id = Number(row.FisioterapeutaId);
    const nome = texto(row.Nome);
    const cidade = texto(row.Cidade);
    const estado = texto(row.Estado)?.toUpperCase() ?? null;
    if (!Number.isInteger(id) || id <= 0 || !nome || !cidade || !/^[A-Z]{2}$/.test(estado || '')) {
      throw new Error('Catálogo SEO: perfil público órfão ou sem localidade canônica.');
    }

    let perfil = perfis.get(id);
    if (!perfil) {
      perfil = {
        fisioterapeutaId: id,
        nome,
        cidade,
        estado,
        especialidades: new Set(),
        seoAtualizadoEm: null,
      };
      perfis.set(id, perfil);
    }

    const especialidade = texto(row.EspecialidadeNome ?? row.Especialidade);
    if (especialidade) perfil.especialidades.add(especialidade);
  }

  const itens = [...perfis.values()]
    .sort((a, b) => a.fisioterapeutaId - b.fisioterapeutaId)
    .map((perfil) => ({
      ...perfil,
      especialidades: [...perfil.especialidades].sort(compararTexto),
    }));

  const cidadesMap = new Map();
  const especialidadesMap = new Map();
  const estados = new Set();

  for (const item of itens) {
    estados.add(item.estado);
    const cidadeKey = `${item.estado}\u0000${item.cidade.toLocaleUpperCase('pt-BR')}`;
    const cidadeAtual = cidadesMap.get(cidadeKey) || {
      nome: item.cidade,
      estado: item.estado,
      quantidade: 0,
    };
    cidadeAtual.quantidade += 1;
    cidadesMap.set(cidadeKey, cidadeAtual);

    for (const nome of item.especialidades) {
      const key = nome.toLocaleUpperCase('pt-BR');
      const atual = especialidadesMap.get(key) || { nome, quantidade: 0 };
      atual.quantidade += 1;
      especialidadesMap.set(key, atual);
    }
  }

  const cidades = [...cidadesMap.values()].sort(
    (a, b) => compararTexto(a.estado, b.estado) || compararTexto(a.nome, b.nome)
  );
  const especialidades = [...especialidadesMap.values()].sort((a, b) => compararTexto(a.nome, b.nome));

  const catalogo = {
    schemaVersion: 1,
    geradoEm,
    resumo: {
      fisioterapeutas: itens.length,
      cidades: cidades.length,
      estados: estados.size,
      especialidades: especialidades.length,
    },
    cidades,
    especialidades,
    itens,
  };

  validarCatalogoSeo(catalogo);
  return catalogo;
}

export function validarCatalogoSeo(catalogo) {
  const { resumo, cidades, especialidades, itens } = catalogo;
  if (resumo.fisioterapeutas !== itens.length) throw new Error('Catálogo SEO: total de fisioterapeutas divergente.');
  if (resumo.cidades !== cidades.length) throw new Error('Catálogo SEO: total de cidades divergente.');
  if (resumo.estados !== new Set(cidades.map((item) => item.estado)).size) {
    throw new Error('Catálogo SEO: total de estados divergente.');
  }
  if (resumo.especialidades !== especialidades.length) throw new Error('Catálogo SEO: total de especialidades divergente.');
  if (cidades.reduce((total, item) => total + item.quantidade, 0) !== itens.length) {
    throw new Error('Catálogo SEO: soma por cidade divergente.');
  }
  if (new Set(itens.map((item) => item.fisioterapeutaId)).size !== itens.length) {
    throw new Error('Catálogo SEO: fisioterapeuta duplicado.');
  }
  for (const item of itens) {
    if (new Set(item.especialidades.map((nome) => nome.toLocaleUpperCase('pt-BR'))).size !== item.especialidades.length) {
      throw new Error(`Catálogo SEO: especialidade duplicada no perfil ${item.fisioterapeutaId}.`);
    }
  }
  return true;
}

async function carregarCatalogoSeo() {
  const [{ ENV }, { queryWithContext }] = await Promise.all([
    import('../config/env.js'),
    import('./_queryWithContext.js'),
  ]);
  const resultado = await queryWithContext(
    { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) },
    null,
    `
      SELECT
        v.FisioterapeutaId,
        v.Nome,
        v.Cidade,
        UPPER(LTRIM(RTRIM(v.Estado))) AS Estado,
        COALESCE(e.Nome, v.Especialidade) AS EspecialidadeNome
      FROM dbo.vw_FisioterapeutaPerfilPublico v
      LEFT JOIN dbo.FisioterapeutasMetricasPublicas fmp
        ON fmp.FisioterapeutaId = v.FisioterapeutaId
      LEFT JOIN dbo.FisioterapeutaEspecialidades fe
        ON fe.FisioterapeutaId = v.FisioterapeutaId
      LEFT JOIN dbo.Especialidades e
        ON e.Id = fe.EspecialidadeId
      WHERE v.Ativo = 1
        AND v.IsBloqueado = 0
        AND v.CrefitoVerificado = 1
        AND ISNULL(fmp.EmailVerificado, 0) = 1
      ORDER BY v.FisioterapeutaId ASC, e.Nome ASC;
    `
  );

  const payload = montarCatalogoSeo(resultado.recordset || []);
  const body = JSON.stringify(payload);
  return {
    payload,
    body,
    etag: `"${crypto.createHash('sha256').update(body).digest('base64url')}"`,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
}

const seoPublicoService = {
  async obterCatalogo() {
    if (cache && cache.expiresAt > Date.now()) return cache;
    cache = await carregarCatalogoSeo();
    return cache;
  },
  limparCache() {
    cache = null;
  },
};

export default seoPublicoService;
