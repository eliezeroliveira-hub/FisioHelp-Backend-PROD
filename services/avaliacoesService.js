// services/avaliacoesService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

// Regras:
// 1) Paciente só avalia Fisioterapeuta se:
//    - teve consulta CONCLUÍDA com aquele fisio
//    - somente a ÚLTIMA consulta concluída conta
//    - somente se essa última consulta ainda não foi avaliada pelo paciente
// 2) Fisioterapeuta só avalia Paciente se:
//    - teve consulta CONCLUÍDA com aquele paciente
//    - somente a ÚLTIMA consulta concluída conta
//    - somente se essa última consulta ainda não foi avaliada pelo fisioterapeuta
// Obs: avaliação é opcional (não impacta o fluxo de concluir consulta).

function isUniqueViolation(err) {
  const num = Number(err?.number);
  const msg = String(err?.message || '').toLowerCase();
  return num === 2601 || num === 2627 || msg.includes('uq_avaliacao_paciente_consulta');
}

function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function normalizePagination(limit, offset) {
  const lim = Number(limit);
  const off = Number(offset);
  return {
    limit: Math.min(Math.max(Number.isFinite(lim) ? Math.trunc(lim) : 50, 1), 200),
    offset: Math.max(Number.isFinite(off) ? Math.trunc(off) : 0, 0)
  };
}

function normalizeNota(nota) {
  const n = asInt(nota);
  if (!Number.isFinite(n) || n < 1 || n > 5) throw new HttpError(400, 'Nota inválida. Use um número entre 1 e 5.');
  return n;
}

function normalizeComentario(comentario) {
  if (comentario === null || comentario === undefined) return null;
  const s = String(comentario).trim();
  if (!s) return null;
  // DB: nvarchar(510)
  return s.slice(0, 510);
}

async function obterPendenciaAvaliacaoFisioterapeuta(usuario, pacienteId, fisioterapeutaId) {
  const pid = asInt(pacienteId);
  const fid = asInt(fisioterapeutaId);
  if (!Number.isFinite(pid) || pid <= 0) throw new HttpError(400, 'PacienteId inválido.');
  if (!Number.isFinite(fid) || fid <= 0) throw new HttpError(400, 'FisioterapeutaId inválido.');

  const result = await queryWithContext(usuario, (req) => {
    req.input('PacienteId', sql.Int, pid);
    req.input('FisioterapeutaId', sql.Int, fid);
  }, `
    SELECT TOP 1
      CAST(CASE WHEN af.Id IS NULL THEN 1 ELSE 0 END AS bit) AS PodeAvaliarFisioterapeuta,
      CASE WHEN af.Id IS NULL THEN c.Id ELSE NULL END AS ConsultaPendenteAvaliacaoId
    FROM dbo.Consultas c
    LEFT JOIN dbo.AvaliacoesFisioterapeutas af
      ON af.ConsultaId = c.Id
     AND af.PacienteId = @PacienteId
     AND af.FisioterapeutaId = @FisioterapeutaId
    WHERE c.PacienteId = @PacienteId
      AND c.FisioterapeutaId = @FisioterapeutaId
      AND LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Concluída'
    ORDER BY c.DataHora DESC, c.Id DESC;
  `);

  const row = result?.recordset?.[0] || null;
  return {
    PodeAvaliarFisioterapeuta: Boolean(row?.PodeAvaliarFisioterapeuta),
    ConsultaPendenteAvaliacaoId:
      row?.ConsultaPendenteAvaliacaoId != null
        ? Number(row.ConsultaPendenteAvaliacaoId)
        : null,
  };
}

async function obterPendenciaAvaliacaoPaciente(usuario, pacienteId, fisioterapeutaId) {
  const pid = asInt(pacienteId);
  const fid = asInt(fisioterapeutaId);
  if (!Number.isFinite(pid) || pid <= 0) throw new HttpError(400, 'PacienteId inválido.');
  if (!Number.isFinite(fid) || fid <= 0) throw new HttpError(400, 'FisioterapeutaId inválido.');

  const result = await queryWithContext(usuario, (req) => {
    req.input('PacienteId', sql.Int, pid);
    req.input('FisioterapeutaId', sql.Int, fid);
  }, `
    SELECT TOP 1
      CAST(CASE WHEN a.Id IS NULL THEN 1 ELSE 0 END AS bit) AS PodeAvaliarPaciente,
      CASE WHEN a.Id IS NULL THEN c.Id ELSE NULL END AS ConsultaPendenteAvaliacaoPacienteId
    FROM dbo.Consultas c
    LEFT JOIN dbo.Avaliacoes a
      ON a.ConsultaId = c.Id
     AND a.PacienteId = @PacienteId
     AND a.FisioterapeutaId = @FisioterapeutaId
    WHERE c.PacienteId = @PacienteId
      AND c.FisioterapeutaId = @FisioterapeutaId
      AND LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Concluída'
    ORDER BY c.DataHora DESC, c.Id DESC;
  `);

  const row = result?.recordset?.[0] || null;
  return {
    PodeAvaliarPaciente: Boolean(row?.PodeAvaliarPaciente),
    ConsultaPendenteAvaliacaoPacienteId:
      row?.ConsultaPendenteAvaliacaoPacienteId != null
        ? Number(row.ConsultaPendenteAvaliacaoPacienteId)
        : null,
  };
}

// ------------------------------
// Paciente -> avalia fisioterapeuta
// ------------------------------
async function avaliarFisioterapeuta(usuario, pacienteId, fisioterapeutaId, nota, comentario) {
  const pid = asInt(pacienteId);
  const fid = asInt(fisioterapeutaId);
  if (!Number.isFinite(pid) || pid <= 0) throw new HttpError(400, 'PacienteId inválido.');
  if (!Number.isFinite(fid) || fid <= 0) throw new HttpError(400, 'FisioterapeutaId inválido.');

  const n = normalizeNota(nota);
  const c = normalizeComentario(comentario);

  let insert;
  try {
    insert = await queryWithContext(usuario, (req) => {
      req.input('PacienteId', sql.Int, pid);
      req.input('FisioterapeutaId', sql.Int, fid);
      req.input('Nota', sql.Int, n);
      req.input('Comentario', sql.NVarChar(510), c);
    }, `
      DECLARE @ConsultaId INT = NULL;
      DECLARE @Ins TABLE (AvaliacaoId INT, ConsultaId INT);

      SELECT TOP 1 @ConsultaId = c.Id
      FROM dbo.Consultas c
      WHERE c.PacienteId = @PacienteId
        AND c.FisioterapeutaId = @FisioterapeutaId
        AND LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Concluída'
      ORDER BY c.DataHora DESC, c.Id DESC;

      IF @ConsultaId IS NULL
        THROW 50040, 'Você só pode avaliar após ter uma consulta CONCLUÍDA com este fisioterapeuta.', 1;

      INSERT INTO dbo.AvaliacoesFisioterapeutas (FisioterapeutaId, PacienteId, Nota, Comentario, ConsultaId)
      OUTPUT INSERTED.Id, INSERTED.ConsultaId INTO @Ins(AvaliacaoId, ConsultaId)
      SELECT @FisioterapeutaId, @PacienteId, @Nota, @Comentario, @ConsultaId
      WHERE NOT EXISTS (
        SELECT 1
        FROM dbo.AvaliacoesFisioterapeutas a
        WHERE a.PacienteId = @PacienteId
          AND a.FisioterapeutaId = @FisioterapeutaId
          AND a.ConsultaId = @ConsultaId
      );

      IF NOT EXISTS (SELECT 1 FROM @Ins)
        THROW 50041, 'Esta última consulta já foi avaliada por você.', 1;

      SELECT TOP 1 AvaliacaoId, ConsultaId FROM @Ins;
    `);
  } catch (err) {
    const msg = String(err?.message || '');
    if (
      msg.includes('já foi avaliada por você')
      || isUniqueViolation(err)
      || Number(err?.number) === 50041
    ) {
      throw new HttpError(409, 'Esta última consulta já foi avaliada por você.');
    }
    if (msg.includes('consulta CONCLUÍDA') || Number(err?.number) === 50040) {
      throw new HttpError(400, 'Você só pode avaliar após ter uma consulta CONCLUÍDA com este fisioterapeuta.');
    }
    throw err;
  }

  const row = insert?.recordset?.[0] || {};
  return {
    AvaliacaoId: row.AvaliacaoId,
    ConsultaId: row.ConsultaId,
    FisioterapeutaId: fid,
    PacienteId: pid,
    Nota: n,
    Comentario: c,
  };
}

// ------------------------------
// Fisioterapeuta -> avalia paciente
// ------------------------------
async function avaliarPaciente(usuario, fisioterapeutaId, pacienteId, nota, comentario) {
  const pid = asInt(pacienteId);
  const fid = asInt(fisioterapeutaId);
  if (!Number.isFinite(pid) || pid <= 0) throw new HttpError(400, 'PacienteId inválido.');
  if (!Number.isFinite(fid) || fid <= 0) throw new HttpError(400, 'FisioterapeutaId inválido.');

  const n = normalizeNota(nota);
  const c = normalizeComentario(comentario);

  let insert;
  try {
    insert = await queryWithContext(usuario, (req) => {
      req.input('PacienteId', sql.Int, pid);
      req.input('FisioterapeutaId', sql.Int, fid);
      req.input('Nota', sql.Int, n);
      req.input('Comentario', sql.NVarChar(510), c);
    }, `
      DECLARE @ConsultaId INT = NULL;
      DECLARE @Ins TABLE (AvaliacaoId INT, ConsultaId INT);

      SELECT TOP 1 @ConsultaId = c.Id
      FROM dbo.Consultas c
      WHERE c.PacienteId = @PacienteId
        AND c.FisioterapeutaId = @FisioterapeutaId
        AND LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Concluída'
      ORDER BY c.DataHora DESC, c.Id DESC;

      IF @ConsultaId IS NULL
        THROW 50042, 'Você só pode avaliar após ter uma consulta CONCLUÍDA com este paciente.', 1;

      INSERT INTO dbo.Avaliacoes (PacienteId, FisioterapeutaId, Nota, Comentario, ConsultaId)
      OUTPUT INSERTED.Id, INSERTED.ConsultaId INTO @Ins(AvaliacaoId, ConsultaId)
      SELECT @PacienteId, @FisioterapeutaId, @Nota, @Comentario, @ConsultaId
      WHERE NOT EXISTS (
        SELECT 1
        FROM dbo.Avaliacoes a
        WHERE a.PacienteId = @PacienteId
          AND a.FisioterapeutaId = @FisioterapeutaId
          AND a.ConsultaId = @ConsultaId
      );

      IF NOT EXISTS (SELECT 1 FROM @Ins)
        THROW 50043, 'Esta última consulta já foi avaliada por você.', 1;

      SELECT TOP 1 AvaliacaoId, ConsultaId FROM @Ins;
    `);
  } catch (err) {
    const msg = String(err?.message || '');
    if (
      msg.includes('já foi avaliada por você')
      || isUniqueViolation(err)
      || Number(err?.number) === 50043
    ) {
      throw new HttpError(409, 'Esta última consulta já foi avaliada por você.');
    }
    if (msg.includes('consulta CONCLUÍDA') || Number(err?.number) === 50042) {
      throw new HttpError(400, 'Você só pode avaliar após ter uma consulta CONCLUÍDA com este paciente.');
    }
    throw err;
  }

  const row = insert?.recordset?.[0] || {};
  return {
    AvaliacaoId: row.AvaliacaoId,
    ConsultaId: row.ConsultaId,
    FisioterapeutaId: fid,
    PacienteId: pid,
    Nota: n,
    Comentario: c,
  };
}

async function listarMinhasAvaliacoes(usuario, pacienteId, { limit = 50, offset = 0 } = {}) {
  const pid = asInt(pacienteId);
  if (!Number.isFinite(pid) || pid <= 0) throw new HttpError(400, 'PacienteId inválido.');
  const pag = normalizePagination(limit, offset);

  const result = await queryWithContext(usuario, (req) => {
    req.input('PacienteId', sql.Int, pid);
    req.input('Limit', sql.Int, pag.limit);
    req.input('Offset', sql.Int, pag.offset);
  }, `
    ;WITH Base AS (
      SELECT
        a.Id,
        a.FisioterapeutaId,
        f.Nome AS FisioterapeutaNome,
        f.CREFITO AS FisioterapeutaCrefito,
        f.FotoPerfilUrl AS FisioterapeutaFotoUrl,
        a.Nota,
        a.Comentario,
        a.DataAvaliacao,
        a.ConsultaId
      FROM dbo.Avaliacoes a
      LEFT JOIN dbo.vw_FisioterapeutaPerfilPublico f ON f.FisioterapeutaId = a.FisioterapeutaId
      WHERE a.PacienteId = @PacienteId
    )
    SELECT COUNT(1) AS Total FROM Base;

    ;WITH Base AS (
      SELECT
        a.Id,
        a.FisioterapeutaId,
        f.Nome AS FisioterapeutaNome,
        f.CREFITO AS FisioterapeutaCrefito,
        f.FotoPerfilUrl AS FisioterapeutaFotoUrl,
        a.Nota,
        a.Comentario,
        a.DataAvaliacao,
        a.ConsultaId
      FROM dbo.Avaliacoes a
      LEFT JOIN dbo.vw_FisioterapeutaPerfilPublico f ON f.FisioterapeutaId = a.FisioterapeutaId
      WHERE a.PacienteId = @PacienteId
    )
    SELECT
      Id,
      FisioterapeutaId,
      FisioterapeutaNome,
      FisioterapeutaCrefito,
      FisioterapeutaFotoUrl,
      Nota,
      Comentario,
      DataAvaliacao,
      ConsultaId
    FROM Base
    ORDER BY DataAvaliacao DESC, Id DESC
    OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
  `);

  return {
    total: result?.recordsets?.[0]?.[0]?.Total ?? 0,
    limit: pag.limit,
    offset: pag.offset,
    itens: result?.recordsets?.[1] || []
  };
}

async function listarAvaliacoesFeitas(usuario, pacienteId, { limit = 50, offset = 0 } = {}) {
  const pid = asInt(pacienteId);
  if (!Number.isFinite(pid) || pid <= 0) throw new HttpError(400, 'PacienteId inválido.');
  const pag = normalizePagination(limit, offset);

  const result = await queryWithContext(usuario, (req) => {
    req.input('PacienteId', sql.Int, pid);
    req.input('Limit', sql.Int, pag.limit);
    req.input('Offset', sql.Int, pag.offset);
  }, `
    ;WITH Base AS (
      SELECT
        a.Id,
        a.FisioterapeutaId,
        f.Nome AS FisioterapeutaNome,
        a.Nota,
        a.Comentario,
        a.DataAvaliacao,
        a.ConsultaId
      FROM dbo.AvaliacoesFisioterapeutas a
      LEFT JOIN dbo.Fisioterapeutas f ON f.Id = a.FisioterapeutaId
      WHERE a.PacienteId = @PacienteId
    )
    SELECT COUNT(1) AS Total FROM Base;

    ;WITH Base AS (
      SELECT
        a.Id,
        a.FisioterapeutaId,
        f.Nome AS FisioterapeutaNome,
        a.Nota,
        a.Comentario,
        a.DataAvaliacao,
        a.ConsultaId
      FROM dbo.AvaliacoesFisioterapeutas a
      LEFT JOIN dbo.Fisioterapeutas f ON f.Id = a.FisioterapeutaId
      WHERE a.PacienteId = @PacienteId
    )
    SELECT
      Id,
      FisioterapeutaId,
      FisioterapeutaNome,
      Nota,
      Comentario,
      DataAvaliacao,
      ConsultaId
    FROM Base
    ORDER BY DataAvaliacao DESC, Id DESC
    OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
  `);

  return {
    total: result?.recordsets?.[0]?.[0]?.Total ?? 0,
    limit: pag.limit,
    offset: pag.offset,
    itens: result?.recordsets?.[1] || []
  };
}

export default {
  avaliarFisioterapeuta,
  avaliarPaciente,
  listarMinhasAvaliacoes,
  listarAvaliacoesFeitas,
  obterPendenciaAvaliacaoFisioterapeuta,
  obterPendenciaAvaliacaoPaciente,
};

export {
  obterPendenciaAvaliacaoFisioterapeuta,
  obterPendenciaAvaliacaoPaciente,
};
