// services/denunciasService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

function normalizeTipo(t) {
  const x = String(t || '').trim().toLowerCase();
  if (x === 'paciente') return 'Paciente';
  if (x === 'fisioterapeuta' || x === 'fisio') return 'Fisioterapeuta';
  if (x === 'admin' || x === 'administrador') return 'Admin';
  return null;
}

function toPositiveInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

function trimOrNull(v, maxLen) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (maxLen && s.length > maxLen) {
    throw new HttpError(400, `Texto excede o limite de ${maxLen} caracteres.`);
  }
  return s;
}

function normalizarPaginacao(limitRaw, offsetRaw) {
  const limitNum = Number(limitRaw);
  const offsetNum = Number(offsetRaw);

  const limit = Number.isFinite(limitNum) ? Math.trunc(limitNum) : 50;
  const offset = Number.isFinite(offsetNum) ? Math.trunc(offsetNum) : 0;

  return {
    limit: Math.min(Math.max(limit, 1), 200),
    offset: Math.max(offset, 0)
  };
}

function isUniqueViolation(err) {
  const num = Number(err?.number);
  const msg = String(err?.message || '').toLowerCase();
  return num === 2601 || num === 2627 || msg.includes('ux_denuncias_ultimaconsulta_unica');
}

function assertAllowedDenunciaPair(denuncianteTipo, denunciadoTipo) {
  const ok =
    (denuncianteTipo === 'Paciente' && denunciadoTipo === 'Fisioterapeuta') ||
    (denuncianteTipo === 'Fisioterapeuta' && denunciadoTipo === 'Paciente');

  if (!ok) {
    throw new HttpError(
      400,
      'denunciadoTipo inválido para este usuário. Somente é permitido denunciar entre Paciente e Fisioterapeuta (tipos diferentes).'
    );
  }
}

async function obterUltimaConsultaIdPorPar({ pacienteId, fisioterapeutaId, usuario }) {
  const sqlText = `
    SELECT TOP 1
      c.Id AS ConsultaId,
      c.DataHora
    FROM dbo.Consultas c
    WHERE c.PacienteId = @PacienteId
      AND c.FisioterapeutaId = @FisioterapeutaId
      AND c.Status IN (N'Concluída', N'Confirmada')
    ORDER BY c.DataHora DESC, c.Id DESC;
  `;

  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('PacienteId', sql.Int, pacienteId);
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    },
    sqlText,
    { requireContext: true }
  );

  const row = result?.recordset?.[0];
  return row?.ConsultaId ? Number(row.ConsultaId) : null;
}

async function validarCategoriaAtiva({ motivoCodigo, usuario }) {
  const sqlText = `
    SELECT TOP 1
      c.Codigo,
      c.Titulo,
      c.Definicao
    FROM dbo.DenunciasCategorias c
    WHERE c.Codigo = @Codigo
      AND c.Ativo = 1;
  `;

  const result = await queryWithContext(
    usuario,
    (req) => req.input('Codigo', sql.NVarChar(40), motivoCodigo),
    sqlText,
    { requireContext: true }
  );

  return result?.recordset?.[0] || null;
}

async function inserirDenuncia({
  consultaId,
  denuncianteTipo,
  denuncianteId,
  denunciadoTipo,
  denunciadoId,
  motivoCodigo,
  motivoTituloSnapshot,
  motivoDefinicaoSnapshot,
  descricao,
  usuario
}) {
  const sqlText = `
    DECLARE @NewId INT;

    INSERT INTO dbo.Denuncias
    (
      DenuncianteTipo,
      DenuncianteId,
      DenunciadoTipo,
      DenunciadoId,
      ConsultaId,
      MotivoCodigo,
      MotivoTituloSnapshot,
      MotivoDefinicaoSnapshot,
      Descricao
    )
    VALUES
    (
      @DenuncianteTipo,
      @DenuncianteId,
      @DenunciadoTipo,
      @DenunciadoId,
      @ConsultaId,
      @MotivoCodigo,
      @MotivoTituloSnapshot,
      @MotivoDefinicaoSnapshot,
      @Descricao
    );

    SET @NewId = SCOPE_IDENTITY();

    SELECT
      d.Id,
      d.DenuncianteTipo,
      d.DenuncianteId,
      d.DenunciadoTipo,
      d.DenunciadoId,
      d.ConsultaId,
      d.MotivoCodigo,
      COALESCE(d.MotivoTituloSnapshot, c.Titulo) AS MotivoTitulo,
      COALESCE(d.MotivoDefinicaoSnapshot, c.Definicao) AS MotivoDefinicao,
      d.Descricao,
      d.Status,
      d.CriadoEm,
      d.ResolvidoEm,
      d.ResolvidoPorAdminId,
      d.ObservacoesAdmin
    FROM dbo.Denuncias d
    LEFT JOIN dbo.DenunciasCategorias c ON c.Codigo = d.MotivoCodigo
    WHERE d.Id = @NewId;
  `;

  let result;
  try {
    result = await queryWithContext(
      usuario,
      (req) => {
        req.input('ConsultaId', sql.Int, consultaId);
        req.input('DenuncianteTipo', sql.NVarChar(20), denuncianteTipo);
        req.input('DenuncianteId', sql.Int, denuncianteId);
        req.input('DenunciadoTipo', sql.NVarChar(20), denunciadoTipo);
        req.input('DenunciadoId', sql.Int, denunciadoId);
        req.input('MotivoCodigo', sql.NVarChar(40), motivoCodigo);
        req.input('MotivoTituloSnapshot', sql.NVarChar(120), motivoTituloSnapshot ?? null);
        req.input('MotivoDefinicaoSnapshot', sql.NVarChar(4000), motivoDefinicaoSnapshot ?? null);
        req.input('Descricao', sql.NVarChar(4000), descricao ?? null);
      },
      sqlText,
      { requireContext: true }
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(
        409,
        'Já existe uma denúncia referente à última consulta com este usuário. Não é permitido denunciar novamente.'
      );
    }
    throw err;
  }

  return result?.recordset?.[0] || null;
}

async function listarDenunciasAdmin({ status, limit, offset, usuario }) {
  const sqlText = `
  ;WITH Base AS (
    SELECT
      d.Id,
      d.DenuncianteTipo,
      d.DenuncianteId,
      d.DenunciadoTipo,
      d.DenunciadoId,
      COALESCE(pDenunciante.Nome, pDenunciado.Nome) AS PacienteNome,
      COALESCE(fDenunciante.Nome, fDenunciado.Nome) AS FisioterapeutaNome,
      d.ConsultaId,
      d.MotivoCodigo,
      COALESCE(d.MotivoTituloSnapshot, c.Titulo) AS MotivoTitulo,
      COALESCE(d.MotivoDefinicaoSnapshot, c.Definicao) AS MotivoDefinicao,
      d.Descricao,
      d.Status,
      d.CriadoEm,
      d.ResolvidoEm,
      d.ResolvidoPorAdminId,
      d.ObservacoesAdmin
    FROM dbo.Denuncias d
    LEFT JOIN dbo.DenunciasCategorias c ON c.Codigo = d.MotivoCodigo
    LEFT JOIN dbo.Pacientes pDenunciante
      ON pDenunciante.Id = d.DenuncianteId AND d.DenuncianteTipo = N'Paciente'
    LEFT JOIN dbo.Pacientes pDenunciado
      ON pDenunciado.Id = d.DenunciadoId AND d.DenunciadoTipo = N'Paciente'
    LEFT JOIN dbo.Fisioterapeutas fDenunciante
      ON fDenunciante.Id = d.DenuncianteId AND d.DenuncianteTipo = N'Fisioterapeuta'
    LEFT JOIN dbo.Fisioterapeutas fDenunciado
      ON fDenunciado.Id = d.DenunciadoId AND d.DenunciadoTipo = N'Fisioterapeuta'
    WHERE (@Status IS NULL OR d.Status = @Status)
  )
  SELECT COUNT(1) AS Total FROM Base;

  ;WITH Base AS (
    SELECT
      d.Id,
      d.DenuncianteTipo,
      d.DenuncianteId,
      d.DenunciadoTipo,
      d.DenunciadoId,
      COALESCE(pDenunciante.Nome, pDenunciado.Nome) AS PacienteNome,
      COALESCE(fDenunciante.Nome, fDenunciado.Nome) AS FisioterapeutaNome,
      d.ConsultaId,
      d.MotivoCodigo,
      COALESCE(d.MotivoTituloSnapshot, c.Titulo) AS MotivoTitulo,
      COALESCE(d.MotivoDefinicaoSnapshot, c.Definicao) AS MotivoDefinicao,
      d.Descricao,
      d.Status,
      d.CriadoEm,
      d.ResolvidoEm,
      d.ResolvidoPorAdminId,
      d.ObservacoesAdmin
    FROM dbo.Denuncias d
    LEFT JOIN dbo.DenunciasCategorias c ON c.Codigo = d.MotivoCodigo
    LEFT JOIN dbo.Pacientes pDenunciante
      ON pDenunciante.Id = d.DenuncianteId AND d.DenuncianteTipo = N'Paciente'
    LEFT JOIN dbo.Pacientes pDenunciado
      ON pDenunciado.Id = d.DenunciadoId AND d.DenunciadoTipo = N'Paciente'
    LEFT JOIN dbo.Fisioterapeutas fDenunciante
      ON fDenunciante.Id = d.DenuncianteId AND d.DenuncianteTipo = N'Fisioterapeuta'
    LEFT JOIN dbo.Fisioterapeutas fDenunciado
      ON fDenunciado.Id = d.DenunciadoId AND d.DenunciadoTipo = N'Fisioterapeuta'
    WHERE (@Status IS NULL OR d.Status = @Status)
  )
  SELECT
    Id,
    DenuncianteTipo,
    DenuncianteId,
    DenunciadoTipo,
    DenunciadoId,
    PacienteNome,
    FisioterapeutaNome,
    ConsultaId,
    MotivoCodigo,
    MotivoTitulo,
    MotivoDefinicao,
    Descricao,
    Status,
    CriadoEm,
    ResolvidoEm,
    ResolvidoPorAdminId,
    ObservacoesAdmin
  FROM Base
  ORDER BY CriadoEm DESC, Id DESC
  OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
`;

  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('Status', sql.NVarChar(20), status ?? null);
      req.input('Offset', sql.Int, offset);
      req.input('Limit', sql.Int, limit);
    },
    sqlText,
    { requireContext: true }
  );

  return {
    total: result?.recordsets?.[0]?.[0]?.Total ?? 0,
    limit,
    offset,
    itens: result?.recordsets?.[1] || []
  };
}

async function concluirDenunciaAdmin({ denunciaId, observacoesAdmin, usuario }) {
  const sqlText = `
    UPDATE dbo.Denuncias
    SET
      Status = N'CONCLUIDA',
      ResolvidoEm = SYSDATETIME(),
      ResolvidoPorAdminId = @AdminId,
      ObservacoesAdmin = @ObservacoesAdmin
    WHERE Id = @Id;

    IF (@@ROWCOUNT = 0)
    BEGIN
      SELECT NULL AS Id;
      RETURN;
    END

    SELECT
      d.Id,
      d.DenuncianteTipo,
      d.DenuncianteId,
      d.DenunciadoTipo,
      d.DenunciadoId,
      d.ConsultaId,
      d.MotivoCodigo,
      COALESCE(d.MotivoTituloSnapshot, c.Titulo) AS MotivoTitulo,
      COALESCE(d.MotivoDefinicaoSnapshot, c.Definicao) AS MotivoDefinicao,
      d.Descricao,
      d.Status,
      d.CriadoEm,
      d.ResolvidoEm,
      d.ResolvidoPorAdminId,
      d.ObservacoesAdmin
    FROM dbo.Denuncias d
    LEFT JOIN dbo.DenunciasCategorias c ON c.Codigo = d.MotivoCodigo
    WHERE d.Id = @Id;
  `;

  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('Id', sql.Int, denunciaId);
      req.input('AdminId', sql.Int, toPositiveInt(usuario?.id));
      req.input('ObservacoesAdmin', sql.NVarChar(2000), observacoesAdmin ?? null);
    },
    sqlText,
    { requireContext: true }
  );

  const row = result?.recordset?.[0];
  return row?.Id ? row : null;
}

const denunciasService = {
  /**
   * GET /denuncias/categorias
   */
  async listarCategorias(usuario) {
    const sqlText = `
      SELECT
        c.Codigo,
        c.Titulo,
        c.Definicao,
        c.Ordem
      FROM dbo.DenunciasCategorias c
      WHERE c.Ativo = 1
      ORDER BY c.Ordem ASC, c.Codigo ASC;
    `;

    const result = await queryWithContext(usuario, null, sqlText, { requireContext: true });
    return result?.recordset || [];
  },

  /**
   * POST /denuncias
   * Body: { denunciadoTipo, denunciadoId, motivo, descricao, consultaId? }
   *
   * Regra A: 1 denúncia total por última consulta (mesmo com motivo diferente).
   */
  async criar(body, usuario) {
    const denuncianteTipo = normalizeTipo(usuario?.tipo);
    const denuncianteId = toPositiveInt(usuario?.id);

    if (!denuncianteTipo || !denuncianteId) {
      throw new HttpError(401, 'Token ausente, inválido ou expirado.');
    }

    if (denuncianteTipo === 'Admin') {
      throw new HttpError(403, 'Admin não pode criar denúncias por este endpoint.');
    }

    const denunciadoTipo = normalizeTipo(body?.denunciadoTipo);
    const denunciadoId = toPositiveInt(body?.denunciadoId);
    const motivoCodigo = trimOrNull(body?.motivo, 40);
    const descricao = trimOrNull(body?.descricao, 4000);
    const consultaIdInformada = body?.consultaId ? toPositiveInt(body.consultaId) : null;

    if (!denunciadoTipo || !denunciadoId) {
      throw new HttpError(400, 'denunciadoTipo/denunciadoId são obrigatórios.');
    }
    if (!motivoCodigo) {
      throw new HttpError(400, 'motivo é obrigatório.');
    }

    assertAllowedDenunciaPair(denuncianteTipo, denunciadoTipo);

    const pacienteId = denuncianteTipo === 'Paciente' ? denuncianteId : denunciadoId;
    const fisioterapeutaId = denuncianteTipo === 'Fisioterapeuta' ? denuncianteId : denunciadoId;

    const ultimaConsultaId = await obterUltimaConsultaIdPorPar({ pacienteId, fisioterapeutaId, usuario });
    if (!ultimaConsultaId) {
      throw new HttpError(
        403,
        'Não é permitido denunciar: não foi encontrada consulta entre este Paciente e este Fisioterapeuta.'
      );
    }

    if (consultaIdInformada && consultaIdInformada !== ultimaConsultaId) {
      throw new HttpError(400, 'consultaId inválida: somente a última consulta do par pode ser usada para denúncia.', {
        ultimaConsultaId
      });
    }

    const categoria = await validarCategoriaAtiva({ motivoCodigo, usuario });
    if (!categoria) {
      throw new HttpError(400, 'motivo inválido ou inativo.');
    }

    const denuncia = await inserirDenuncia({
      consultaId: ultimaConsultaId,
      denuncianteTipo,
      denuncianteId,
      denunciadoTipo,
      denunciadoId,
      motivoCodigo: categoria.Codigo,
      motivoTituloSnapshot: categoria.Titulo,
      motivoDefinicaoSnapshot: categoria.Definicao,
      descricao,
      usuario
    });

    return { denuncia, ultimaConsultaId, categoria };
  },

  /**
   * GET /admin/denuncias?status=aberta|concluida
   */
  async adminListar(query, usuario) {
    const tipo = normalizeTipo(usuario?.tipo);
    if (tipo !== 'Admin') throw new HttpError(403, 'Somente Admin pode listar denúncias.');

    const st = String(query?.status || '').trim().toLowerCase();
    let status = null;

    if (st) {
      if (st === 'aberta' || st === 'aberto') status = 'ABERTA';
      else if (st === 'concluida' || st === 'concluído') status = 'CONCLUIDA';
      else throw new HttpError(400, 'status inválido. Use: aberta | concluida');
    }

    const { limit, offset } = normalizarPaginacao(query?.limit, query?.offset);
    return await listarDenunciasAdmin({ status, limit, offset, usuario });
  },

  /**
   * POST /admin/denuncias/:id/decidir
   * Body: { observacoesAdmin? }
   */
  async adminDecidir(id, body, usuario) {
    const tipo = normalizeTipo(usuario?.tipo);
    if (tipo !== 'Admin') throw new HttpError(403, 'Somente Admin pode decidir denúncias.');

    const denunciaId = toPositiveInt(id);
    if (!denunciaId) throw new HttpError(400, 'Id inválido.');

    const observacoesAdmin = trimOrNull(body?.observacoesAdmin, 2000);

    const denuncia = await concluirDenunciaAdmin({ denunciaId, observacoesAdmin, usuario });
    if (!denuncia) throw new HttpError(404, 'Denúncia não encontrada.');

    return denuncia;
  }
};

export { HttpError };
export default denunciasService;
