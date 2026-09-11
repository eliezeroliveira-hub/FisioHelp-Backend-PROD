import crypto from 'crypto';
import { ENV } from '../config/env.js';
import { sql } from '../config/dbConfig.js';
import { log } from '../config/logger.js';
import { queryWithContext } from '../services/_queryWithContext.js';
import { buildSeoCityPath, buildSeoProfilePath, SEO_SITE_ORIGIN } from '../utils/seoUrl.js';

const enabled = /^(1|true|yes)$/i.test(String(process.env.INDEXNOW_ENABLED || 'false'));
const intervalMs = Math.max(60_000, Number(process.env.INDEXNOW_INTERVAL_MS || 15 * 60_000));
const key = String(process.env.INDEXNOW_KEY || 'da095e77fadc4dc384a6eda6697a6477').trim();
const endpoint = String(process.env.INDEXNOW_ENDPOINT || 'https://api.indexnow.org/indexnow').trim();
const context = { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
let timer = null;
let running = false;

function absolute(path) {
  return path ? new URL(path, SEO_SITE_ORIGIN).toString() : null;
}

function signature(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function groupProfiles(rows) {
  const profiles = new Map();
  for (const row of rows || []) {
    const id = Number(row.FisioterapeutaId);
    if (!Number.isInteger(id) || id <= 0) continue;
    let profile = profiles.get(id);
    if (!profile) {
      profile = {
        fisioterapeutaId: id,
        nome: String(row.Nome || '').trim(),
        cidade: String(row.Cidade || '').trim(),
        estado: String(row.Estado || '').trim().toUpperCase(),
        descricao: String(row.Descricao || '').trim(),
        fotoPerfilDocumentoId: Number(row.FotoPerfilDocumentoId) || null,
        especialidades: new Set(),
      };
      profiles.set(id, profile);
    }
    const specialty = String(row.EspecialidadeNome || row.Especialidade || '').trim();
    if (specialty) profile.especialidades.add(specialty);
  }
  return [...profiles.values()].map((profile) => {
    const normalized = { ...profile, especialidades: [...profile.especialidades].sort() };
    return {
      ...normalized,
      urlCanonica: absolute(buildSeoProfilePath(normalized)),
      urlCidade: absolute(buildSeoCityPath(normalized)),
      assinatura: signature(normalized),
    };
  }).filter((profile) => profile.urlCanonica && profile.urlCidade);
}

async function loadProfiles() {
  const result = await queryWithContext(context, null, `
    SELECT v.FisioterapeutaId, v.Nome, v.Cidade, v.Estado, v.Descricao,
      v.FotoPerfilDocumentoId, COALESCE(e.Nome, v.Especialidade) AS EspecialidadeNome
    FROM dbo.vw_FisioterapeutaPerfilPublico v
    LEFT JOIN dbo.FisioterapeutasMetricasPublicas fmp ON fmp.FisioterapeutaId = v.FisioterapeutaId
    LEFT JOIN dbo.FisioterapeutaEspecialidades fe ON fe.FisioterapeutaId = v.FisioterapeutaId
    LEFT JOIN dbo.Especialidades e ON e.Id = fe.EspecialidadeId
    WHERE v.Ativo = 1 AND v.IsBloqueado = 0 AND v.CrefitoVerificado = 1
      AND ISNULL(fmp.EmailVerificado, 0) = 1
    ORDER BY v.FisioterapeutaId, e.Nome;
  `);
  return groupProfiles(result.recordset || []);
}

async function reconcile() {
  const profiles = await loadProfiles();
  const result = await queryWithContext(context, (request) => {
    request.input('PerfisJson', sql.NVarChar(sql.MAX), JSON.stringify(profiles));
  }, `
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @Agora DATETIME2(0) = SYSDATETIME();
    DECLARE @Perfis TABLE (
      FisioterapeutaId INT PRIMARY KEY, UrlCanonica NVARCHAR(600), UrlCidade NVARCHAR(600), Assinatura CHAR(64)
    );
    INSERT INTO @Perfis
    SELECT fisioterapeutaId, urlCanonica, urlCidade, assinatura FROM OPENJSON(@PerfisJson)
    WITH (fisioterapeutaId INT, urlCanonica NVARCHAR(600), urlCidade NVARCHAR(600), assinatura CHAR(64));

    DECLARE @Mudancas TABLE (Url NVARCHAR(600), Motivo NVARCHAR(60));
    INSERT INTO @Mudancas
    SELECT p.UrlCanonica, N'perfil-atualizado' FROM @Perfis p
    LEFT JOIN dbo.SeoPerfilEstado s ON s.FisioterapeutaId = p.FisioterapeutaId
    WHERE s.FisioterapeutaId IS NULL OR s.Assinatura <> p.Assinatura OR s.UrlCanonica <> p.UrlCanonica
    UNION
    SELECT s.UrlCanonica, N'perfil-url-anterior' FROM dbo.SeoPerfilEstado s
    LEFT JOIN @Perfis p ON p.FisioterapeutaId = s.FisioterapeutaId
    WHERE p.FisioterapeutaId IS NULL OR p.UrlCanonica <> s.UrlCanonica
    UNION
    SELECT p.UrlCidade, N'cidade-atualizada' FROM @Perfis p
    LEFT JOIN dbo.SeoPerfilEstado s ON s.FisioterapeutaId = p.FisioterapeutaId
    WHERE s.FisioterapeutaId IS NULL OR s.Assinatura <> p.Assinatura OR s.UrlCidade <> p.UrlCidade
    UNION
    SELECT s.UrlCidade, N'cidade-anterior' FROM dbo.SeoPerfilEstado s
    LEFT JOIN @Perfis p ON p.FisioterapeutaId = s.FisioterapeutaId
    WHERE p.FisioterapeutaId IS NULL OR p.UrlCidade <> s.UrlCidade;

    IF EXISTS (SELECT 1 FROM @Mudancas)
      INSERT INTO @Mudancas VALUES
        (N'https://fisiohelp.com.br/sitemap.xml', N'sitemap'),
        (N'https://fisiohelp.com.br/sitemap-cidades.xml', N'sitemap'),
        (N'https://fisiohelp.com.br/sitemap-fisioterapeutas.xml', N'sitemap');

    INSERT INTO dbo.IndexNowFila (Url, Motivo, Status, Tentativas, ProximaTentativaEm, CriadoEm, AtualizadoEm)
    SELECT DISTINCT m.Url, m.Motivo, N'Pendente', 0, @Agora, @Agora, @Agora
    FROM @Mudancas m
    WHERE m.Url IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM dbo.IndexNowFila f WHERE f.Url = m.Url AND f.Status IN (N'Pendente', N'Processando')
    );

    MERGE dbo.SeoPerfilEstado AS target USING @Perfis AS source
      ON target.FisioterapeutaId = source.FisioterapeutaId
    WHEN MATCHED THEN UPDATE SET UrlCanonica=source.UrlCanonica, UrlCidade=source.UrlCidade,
      Assinatura=source.Assinatura, AtualizadoEm=@Agora
    WHEN NOT MATCHED THEN INSERT (FisioterapeutaId, UrlCanonica, UrlCidade, Assinatura, AtualizadoEm)
      VALUES (source.FisioterapeutaId, source.UrlCanonica, source.UrlCidade, source.Assinatura, @Agora)
    WHEN NOT MATCHED BY SOURCE THEN DELETE;
    DELETE FROM dbo.IndexNowFila WHERE Status=N'Concluido' AND AtualizadoEm < DATEADD(DAY, -30, @Agora);
    COMMIT;
    SELECT COUNT(*) AS Total FROM @Mudancas;
  `);
  return Number(result.recordset?.[0]?.Total || 0);
}

async function claimBatch() {
  const result = await queryWithContext(context, null, `
    SET XACT_ABORT ON; BEGIN TRANSACTION;
    UPDATE dbo.IndexNowFila SET Status=N'Pendente', AtualizadoEm=SYSDATETIME()
      WHERE Status=N'Processando' AND AtualizadoEm < DATEADD(MINUTE, -30, SYSDATETIME());
    ;WITH lote AS (
      SELECT TOP (100) * FROM dbo.IndexNowFila WITH (UPDLOCK, READPAST, ROWLOCK)
      WHERE Status=N'Pendente' AND ProximaTentativaEm <= SYSDATETIME()
      ORDER BY Id
    )
    UPDATE lote SET Status=N'Processando', AtualizadoEm=SYSDATETIME()
      OUTPUT inserted.Id, inserted.Url, inserted.Tentativas;
    COMMIT;
  `);
  return result.recordset || [];
}

async function finishBatch(batch, ok, errorMessage = null) {
  if (!batch.length) return;
  await queryWithContext(context, (request) => {
    request.input('IdsJson', sql.NVarChar(sql.MAX), JSON.stringify(batch.map((item) => item.Id)));
    request.input('Erro', sql.NVarChar(1000), errorMessage ? String(errorMessage).slice(0, 1000) : null);
  }, ok ? `
    UPDATE f SET Status=N'Concluido', AtualizadoEm=SYSDATETIME(), UltimoErro=NULL
    FROM dbo.IndexNowFila f JOIN OPENJSON(@IdsJson) j ON f.Id=TRY_CAST(j.[value] AS BIGINT);
  ` : `
    UPDATE f SET Status=N'Pendente', Tentativas=Tentativas+1, UltimoErro=@Erro,
      ProximaTentativaEm=DATEADD(MINUTE, CASE WHEN Tentativas < 5 THEN POWER(2, Tentativas) ELSE 60 END, SYSDATETIME()),
      AtualizadoEm=SYSDATETIME()
    FROM dbo.IndexNowFila f JOIN OPENJSON(@IdsJson) j ON f.Id=TRY_CAST(j.[value] AS BIGINT);
  `);
}

export async function runIndexNowCycle(fetchImpl = globalThis.fetch) {
  const changed = await reconcile();
  const batch = await claimBatch();
  if (!batch.length) return { changed, submitted: 0 };
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'fisiohelp.com.br', key,
        keyLocation: `${SEO_SITE_ORIGIN}/${key}.txt`,
        urlList: batch.map((item) => item.Url),
      }),
    });
    if (!response.ok) throw new Error(`IndexNow HTTP ${response.status}`);
    await finishBatch(batch, true);
    return { changed, submitted: batch.length };
  } catch (error) {
    await finishBatch(batch, false, error?.message);
    throw error;
  }
}

export function startIndexNowWorker() {
  if (!enabled || timer) return { enabled, started: false };
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runIndexNowCycle();
      if (result.changed || result.submitted) log('info', 'IndexNow processado', result);
    } catch (error) {
      log('warn', 'Falha no ciclo IndexNow', { erro: error?.message });
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 30_000).unref?.();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { enabled, started: true };
}
