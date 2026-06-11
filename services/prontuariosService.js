//  services/prontuariosService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import PDFDocument from 'pdfkit';
import { HttpError } from '../utils/httpError.js';
import { createHash } from 'crypto';

function isFisio(usuario) {
  return String(usuario?.tipo || '').toLowerCase() === 'fisioterapeuta';
}

function assertUser(usuario) {
  if (!usuario?.id || !usuario?.tipo) throw new HttpError(401, 'Não autenticado.');
  if (!isFisio(usuario)) throw new HttpError(403, 'Acesso negado.');
}

function assertInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} inválido.`);
  return n;
}

const MAX_LONG_TEXT_BYTES = 500_000; // ~500KB por campo textual longo

function normalizeLongText(v, maxBytes = MAX_LONG_TEXT_BYTES) {
  if (v === undefined) return undefined; // mantém "não enviado"
  if (v === null) return null;
  const s = String(v);
  if (!s.trim().length) return null;
  if (Buffer.byteLength(s, 'utf8') > maxBytes) {
    throw new HttpError(400, 'Texto excede o limite permitido.');
  }
  return s;
}

function normalizeDateOnly(v) {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === '') return null;

  // Aceita "YYYY-MM-DD" (preferido)
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new HttpError(400, 'DataEvolucao inválida. Use YYYY-MM-DD.');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);

  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) {
    throw new HttpError(400, 'DataEvolucao inválida. Use YYYY-MM-DD.');
  }
  if (mo < 1 || mo > 12) throw new HttpError(400, 'DataEvolucao inválida: mês fora do intervalo 01-12.');
  if (d < 1 || d > 31) throw new HttpError(400, 'DataEvolucao inválida: dia fora do intervalo 01-31.');

  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    Number.isNaN(dt.getTime()) ||
    dt.getUTCFullYear() !== y ||
    (dt.getUTCMonth() + 1) !== mo ||
    dt.getUTCDate() !== d
  ) {
    throw new HttpError(400, 'DataEvolucao inválida: data inexistente no calendário.');
  }
  return s; // passaremos como Date em SQL via CAST(@DataEvolucao AS date)
}


function trimOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function toSafeSlug(value, fallback = 'arquivo') {
  const raw = trimOrNull(value) || fallback;
  return String(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function isBlank(v) {
  return trimOrNull(v) === null;
}

function parseDateOrNull(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return d;
}

// true quando current é NULL/ inválido ou quando incoming é mais recente
function shouldUpdateDate(currentValue, incomingValue) {
  const cur = parseDateOrNull(currentValue);
  const inc = parseDateOrNull(incomingValue);
  if (!inc) return false;
  if (!cur) return true;
  return inc.getTime() > cur.getTime();
}

async function assertFisioAtendeuPaciente(usuario, pacienteId) {
  const fisioterapeutaId = assertInt(usuario.id, 'Usuário');

  const vinculo = await queryWithContext(
    usuario,
    (req) => {
      req.input('PacienteId', sql.Int, pacienteId);
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    },
    `
    SELECT TOP 1 1 AS Ok
    FROM dbo.FisioPacientesCarteira
    WHERE PacienteId = @PacienteId
      AND FisioterapeutaId = @FisioterapeutaId
      AND Ativo = 1

    UNION ALL

    SELECT TOP 1 1
    FROM dbo.Consultas
    WHERE PacienteId = @PacienteId
      AND FisioterapeutaId = @FisioterapeutaId
      AND Status IN (N'Confirmada', N'Concluída');
    `
  );

  if (!vinculo.recordset?.length) {
    throw new HttpError(403, 'Sem permissão: este paciente não possui vínculo com você.');
  }
}

async function obterSnapshotConsultaConfirmada(usuario, pacienteId) {
  const fisioterapeutaId = assertInt(usuario.id, 'Usuário');

  const r = await queryWithContext(
    usuario,
    (req) => {
      req.input('PacienteId', sql.Int, pacienteId);
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    },
    `
    SELECT TOP 1
      c.Id                           AS ConsultaId,
      c.Status                       AS ConsultaStatus,
      c.DataHora                     AS ConsultaDataHora,
      c.ConfirmadaEm                 AS ConsultaConfirmadaEm,
      c.DataEncerramento             AS ConsultaDataEncerramento,

      p.Id                           AS PacienteId,
      p.Nome                         AS PacienteNomeCompleto,
      p.Naturalidade                 AS PacienteNaturalidade,
      p.EstadoCivil                  AS PacienteEstadoCivil,
      p.Genero                       AS PacienteGenero,
      p.Cidade                       AS PacienteCidade,
      p.Estado                       AS PacienteEstado,
      p.DataNascimento               AS PacienteDataNascimento,
      p.Profissao                    AS PacienteProfissao,
      p.EnderecoComercial            AS EnderecoComercial,
      p.EnderecoResidencial          AS EnderecoResidencial,
      p.Cep                          AS PacienteCep,
      p.CepComercial                 AS PacienteCepComercial,

      f.Nome                         AS ProfissionalNome,
      f.CREFITO                      AS ProfissionalCrefito
    FROM dbo.Consultas c
    INNER JOIN dbo.Pacientes p       ON p.Id = c.PacienteId
    INNER JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
    WHERE c.PacienteId = @PacienteId
      AND c.FisioterapeutaId = @FisioterapeutaId
      AND LTRIM(RTRIM(ISNULL(c.Status, N''))) IN (N'Confirmada', N'Concluída')
    ORDER BY
    CASE WHEN LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Concluída' THEN 0 ELSE 1 END,
    ISNULL(c.DataEncerramento, ISNULL(c.ConfirmadaEm, c.DataHora)) DESC,
    c.Id DESC;
    `
  );

  let snap = r.recordset?.[0] || null;

  if (!snap) {
    const rPac = await queryWithContext(
      usuario,
      (req) => {
        req.input('PacienteId', sql.Int, pacienteId);
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      },
      `
      SELECT TOP 1
        NULL                          AS ConsultaId,
        NULL                          AS ConsultaStatus,
        NULL                          AS ConsultaDataHora,
        NULL                          AS ConsultaConfirmadaEm,
        NULL                          AS ConsultaDataEncerramento,

        p.Id                          AS PacienteId,
        p.Nome                        AS PacienteNomeCompleto,
        p.Naturalidade                AS PacienteNaturalidade,
        p.EstadoCivil                 AS PacienteEstadoCivil,
        p.Genero                      AS PacienteGenero,
        p.Cidade                      AS PacienteCidade,
        p.Estado                      AS PacienteEstado,
        p.DataNascimento              AS PacienteDataNascimento,
        p.Profissao                   AS PacienteProfissao,
        p.EnderecoComercial           AS EnderecoComercial,
        p.EnderecoResidencial         AS EnderecoResidencial,
        p.Cep                         AS PacienteCep,
        p.CepComercial                AS PacienteCepComercial,

        f.Nome                        AS ProfissionalNome,
        f.CREFITO                     AS ProfissionalCrefito
      FROM dbo.Pacientes p
      INNER JOIN dbo.Fisioterapeutas f
        ON f.Id = @FisioterapeutaId
      WHERE p.Id = @PacienteId;
      `
    );

    snap = rPac.recordset?.[0] || null;
  }

  if (!snap) {
    throw new HttpError(409, 'Não foi possível montar o snapshot do prontuário para este paciente.');
  }

  // Endereços: preencher cada coluna com o seu respectivo campo
  const endRes = trimOrNull(snap.EnderecoResidencial);
  const endCom = trimOrNull(snap.EnderecoComercial);

  // Local de nascimento: tenta Cidade/Estado (quando existir), senão cai para Naturalidade
  const cidade = trimOrNull(snap.PacienteCidade);
  const estado = trimOrNull(snap.PacienteEstado);
  const naturalidade = trimOrNull(snap.PacienteNaturalidade);

  let pacienteLocalNascimento = null;
  if (cidade && estado) pacienteLocalNascimento = `${cidade} - ${estado}`;
  else if (cidade) pacienteLocalNascimento = cidade;
  else if (estado) pacienteLocalNascimento = estado;
  else pacienteLocalNascimento = naturalidade;

  // Datas automáticas: SOMENTE quando a consulta for CONCLUÍDA
  const st = String(snap.ConsultaStatus || '').trim().toLowerCase();
  const ehConcluida = (st === 'concluída' || st === 'concluida');

  const dataBase = ehConcluida
    ? (snap.ConsultaDataEncerramento || snap.ConsultaConfirmadaEm || snap.ConsultaDataHora || null)
    : null;

  return {
    ...snap,

    PacienteNomeCompleto: trimOrNull(snap.PacienteNomeCompleto),
    PacienteNaturalidade: naturalidade,
    PacienteEstadoCivil: trimOrNull(snap.PacienteEstadoCivil),
    PacienteGenero: trimOrNull(snap.PacienteGenero),
    PacienteLocalNascimento: pacienteLocalNascimento,
    PacienteProfissao: trimOrNull(snap.PacienteProfissao),
    PacienteCep: trimOrNull(snap.PacienteCep),
    PacienteCepComercial: trimOrNull(snap.PacienteCepComercial),

    ProfissionalNome: trimOrNull(snap.ProfissionalNome),
    ProfissionalCrefito: trimOrNull(snap.ProfissionalCrefito),

    ProntuarioEnderecoResidencial: endRes,
    ProntuarioEnderecoComercial: endCom,

    // DataCriacao - Data de conclusão da consulta (fallback: confirmação / DataHora)
    ProntuarioDataCriacao: dataBase,

    // DataRegistroProcedimentos - alinhado com a conclusão (fallback: confirmação / DataHora)
    DataRegistroProcedimentos: dataBase,
  };
}

async function sincronizarCamposAutomaticosDoProntuario(usuario, prontuario) {
  const snap = await obterSnapshotConsultaConfirmada(usuario, prontuario.PacienteId);

  const updates = [];
  const inputs = [];

  const setIfBlank = (col, param, type, currentValue, newValue) => {
    const v = trimOrNull(newValue);
    if (isBlank(currentValue) && !isBlank(v)) {
      updates.push(`${col} = @${param}`);
      inputs.push({ name: param, type, value: v });
    }
  };

  const setDateIfNewer = (col, param, type, currentValue, newValue) => {
    if (!shouldUpdateDate(currentValue, newValue)) return;
    const d = parseDateOrNull(newValue);
    if (!d) return;
    updates.push(`${col} = @${param}`);
    inputs.push({ name: param, type, value: d });
  };

  // (autopreenchimento)
  setIfBlank('PacienteNomeCompleto', 'PacienteNomeCompleto', sql.NVarChar(600), prontuario.PacienteNomeCompleto, snap.PacienteNomeCompleto);
  setIfBlank('PacienteNaturalidade', 'PacienteNaturalidade', sql.NVarChar(240), prontuario.PacienteNaturalidade, snap.PacienteNaturalidade);
  setIfBlank('PacienteEstadoCivil', 'PacienteEstadoCivil', sql.NVarChar(120), prontuario.PacienteEstadoCivil, snap.PacienteEstadoCivil);
  setIfBlank('PacienteGenero', 'PacienteGenero', sql.NVarChar(40), prontuario.PacienteGenero, snap.PacienteGenero);
  setIfBlank('PacienteLocalNascimento', 'PacienteLocalNascimento', sql.NVarChar(400), prontuario.PacienteLocalNascimento, snap.PacienteLocalNascimento);
  setIfBlank('PacienteDataNascimento', 'PacienteDataNascimento', sql.Date, prontuario.PacienteDataNascimento, snap.PacienteDataNascimento);
  setIfBlank('PacienteProfissao', 'PacienteProfissao', sql.NVarChar(240), prontuario.PacienteProfissao, snap.PacienteProfissao);
  setIfBlank('PacienteEnderecoComercial', 'PacienteEnderecoComercial', sql.NVarChar(1600), prontuario.PacienteEnderecoComercial, snap.ProntuarioEnderecoComercial);
  setIfBlank('PacienteCep', 'PacienteCep', sql.NVarChar(18), prontuario.PacienteCep, snap.PacienteCep);
  setIfBlank('ProfissionalNome', 'ProfissionalNome', sql.NVarChar(600), prontuario.ProfissionalNome, snap.ProfissionalNome);
  setIfBlank('ProfissionalCrefito', 'ProfissionalCrefito', sql.NVarChar(60), prontuario.ProfissionalCrefito, snap.ProfissionalCrefito);

  // manter residencial preenchido também
  setIfBlank('PacienteEnderecoResidencial', 'PacienteEnderecoResidencial', sql.NVarChar(1600), prontuario.PacienteEnderecoResidencial, snap.ProntuarioEnderecoResidencial);

  // Datas:
  // - DataCriacao: setar só uma vez (quando estiver NULL)
  // - DataRegistroProcedimentos: atualiza quando houver consulta concluída mais recente
  if (!prontuario.DataCriacao) {
    setDateIfNewer('DataCriacao', 'DataCriacao', sql.DateTime, null, snap.ProntuarioDataCriacao);
  }
  setDateIfNewer(
    'DataRegistroProcedimentos',
    'DataRegistroProcedimentos',
    sql.DateTime2,
    prontuario.DataRegistroProcedimentos,
    snap.DataRegistroProcedimentos
  );


  if (!updates.length) return await enriquecerProntuario(usuario, prontuario);

  const updated = await queryWithContext(
    usuario,
    (req) => {
      req.input('Id', sql.Int, prontuario.Id);
      req.input('FisioterapeutaId', sql.Int, Number(usuario.id));
      for (const p of inputs) req.input(p.name, p.type, p.value);
    },
    `
    UPDATE dbo.Prontuarios
    SET ${updates.join(', ')},
        DataUltimaAtualizacao = SYSDATETIME()
    WHERE Id = @Id
      AND FisioterapeutaId = @FisioterapeutaId;

    SELECT TOP 1 *
    FROM dbo.Prontuarios
    WHERE Id = @Id
      AND FisioterapeutaId = @FisioterapeutaId;
    `
  );

  return updated.recordset?.[0] || prontuario;
}

async function consultarProntuarioRaw(usuario, pacienteId) {
  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('PacienteId', sql.Int, pacienteId);
      req.input('FisioterapeutaId', sql.Int, Number(usuario.id));
    },
    `
      SELECT TOP 1 *
      FROM dbo.Prontuarios
      WHERE PacienteId = @PacienteId
        AND FisioterapeutaId = @FisioterapeutaId
      ORDER BY DataUltimaAtualizacao DESC, Id DESC;
    `
  );

  return result.recordset?.[0] || null;
}

async function enriquecerProntuario(usuario, prontuario) {
  if (!prontuario) return null;
  const snap = await obterSnapshotConsultaConfirmada(usuario, prontuario.PacienteId);
  return {
    ...prontuario,
    PacienteCepComercial: trimOrNull(prontuario.PacienteCepComercial) || trimOrNull(snap.PacienteCepComercial),
  };
}

const prontuariosService = {
  /**
   * GET prontuário do paciente (do fisio logado), sem side effects.
   * Uso interno para fluxos que exigem leitura pura.
   */
  async _obterRaw(usuario, pacienteId) {
    assertUser(usuario);
    const pid = assertInt(pacienteId, 'PacienteId');
    await assertFisioAtendeuPaciente(usuario, pid);
    return consultarProntuarioRaw(usuario, pid);
  },

  /**
   * GET prontuário do paciente (do fisio logado)
   */
  async obter(usuario, pacienteId) {
    assertUser(usuario);
    const pid = assertInt(pacienteId, 'PacienteId');

    await assertFisioAtendeuPaciente(usuario, pid);

    let prontuario = await consultarProntuarioRaw(usuario, pid);

    // Se ainda não existe, cria automaticamente (pré-preenchido)
    if (!prontuario) {
      const snap = await obterSnapshotConsultaConfirmada(usuario, pid);

    const created = await queryWithContext(
      usuario,
      (req) => {
        req.input('PacienteId', sql.Int, pid);
        req.input('FisioterapeutaId', sql.Int, Number(usuario.id));

        req.input('DataCriacao', sql.DateTime, snap.ProntuarioDataCriacao ?? null);
        req.input('DataRegistroProcedimentos', sql.DateTime2, snap.DataRegistroProcedimentos ?? null);

        req.input('PacienteNomeCompleto', sql.NVarChar(600), snap.PacienteNomeCompleto ?? null);
        req.input('PacienteNaturalidade', sql.NVarChar(300), snap.PacienteNaturalidade ?? null);
        req.input('PacienteEstadoCivil', sql.NVarChar(80), snap.PacienteEstadoCivil ?? null);
        req.input('PacienteGenero', sql.NVarChar(80), snap.PacienteGenero ?? null);
        req.input('PacienteLocalNascimento', sql.NVarChar(300), snap.PacienteLocalNascimento ?? null);
        req.input('PacienteProfissao', sql.NVarChar(220), snap.PacienteProfissao ?? null);
        req.input('PacienteCep', sql.NVarChar(18), snap.PacienteCep ?? null);

        req.input('PacienteEnderecoResidencial', sql.NVarChar(1600), snap.ProntuarioEnderecoResidencial ?? null);
        req.input('PacienteEnderecoComercial', sql.NVarChar(1600), snap.ProntuarioEnderecoComercial ?? null);

        req.input('ProfissionalNome', sql.NVarChar(600), snap.ProfissionalNome ?? null);
        req.input('ProfissionalCrefito', sql.NVarChar(60), snap.ProfissionalCrefito ?? null);
      },
      `
      SET NOCOUNT ON;

      IF EXISTS (
        SELECT 1
        FROM dbo.Prontuarios WITH (UPDLOCK, HOLDLOCK)
        WHERE PacienteId = @PacienteId
          AND FisioterapeutaId = @FisioterapeutaId
      )
      BEGIN
        SELECT TOP 1 *
        FROM dbo.Prontuarios
        WHERE PacienteId = @PacienteId
          AND FisioterapeutaId = @FisioterapeutaId
        ORDER BY DataUltimaAtualizacao DESC, Id DESC;
      END
      ELSE
      BEGIN
        INSERT INTO dbo.Prontuarios (
          PacienteId, FisioterapeutaId,
          DataCriacao, DataRegistroProcedimentos,
          PacienteNomeCompleto, PacienteNaturalidade, PacienteEstadoCivil, PacienteGenero,
          PacienteLocalNascimento, PacienteProfissao, PacienteCep,
          PacienteEnderecoResidencial, PacienteEnderecoComercial,
          ProfissionalNome, ProfissionalCrefito,
          DataUltimaAtualizacao
        )
        VALUES (
          @PacienteId, @FisioterapeutaId,
          @DataCriacao, @DataRegistroProcedimentos,
          @PacienteNomeCompleto, @PacienteNaturalidade, @PacienteEstadoCivil, @PacienteGenero,
          @PacienteLocalNascimento, @PacienteProfissao, @PacienteCep,
          @PacienteEnderecoResidencial, @PacienteEnderecoComercial,
          @ProfissionalNome, @ProfissionalCrefito,
          SYSDATETIME()
        );

        DECLARE @NewId INT = CAST(SCOPE_IDENTITY() AS INT);

        SELECT TOP 1 *
        FROM dbo.Prontuarios
        WHERE Id = @NewId;
      END
      `
    );

    prontuario = created.recordset?.[0] || null;
  }

  if (!prontuario) return null;
  return await enriquecerProntuario(usuario, prontuario);

  },

  /**
   * POST cria prontuário (1 por par Paciente/Fisio)
   * - preenche automaticamente campos do paciente a partir da consulta mais recente
   *   ou, na ausência de consulta, a partir do cadastro do paciente
   * - DataCriacao = Consulta.ConfirmadaEm (fallback: Consulta.DataHora)
   * - DataRegistroProcedimentos = Consulta.DataHora (não usa check-in)
   */
  async criar(usuario, pacienteId, payload) {
    assertUser(usuario);
    const pid = assertInt(pacienteId, 'PacienteId');

    await assertFisioAtendeuPaciente(usuario, pid);

    // Idempotente: se já existir, retorna o existente (sem 409)
    const rExiste = await queryWithContext(
      usuario,
      (req) => {
        req.input('PacienteId', sql.Int, pid);
        req.input('FisioterapeutaId', sql.Int, Number(usuario.id));
      },
      `
      SELECT TOP 1 *
      FROM dbo.Prontuarios
      WHERE PacienteId = @PacienteId
        AND FisioterapeutaId = @FisioterapeutaId
      ORDER BY DataUltimaAtualizacao DESC, Id DESC;
      `
    );

    const existente = rExiste.recordset?.[0] || null;
    if (existente) {
      // opcional: sincroniza automáticos caso falte algo
      return await enriquecerProntuario(
        usuario,
        await sincronizarCamposAutomaticosDoProntuario(usuario, existente)
      );
    }

    const snap = await obterSnapshotConsultaConfirmada(usuario, pid);

    // Campos editáveis (opcionais)
    const historia = normalizeLongText(payload?.HistoriaClinica ?? payload?.historiaClinica);
    const detalhamento = normalizeLongText(payload?.DetalhamentoCaso ?? payload?.detalhamentoCaso);
    const plano = normalizeLongText(payload?.PlanoTerapeutico ?? payload?.planoTerapeutico);

    const queixa = normalizeLongText(payload?.QueixaPrincipal ?? payload?.queixaPrincipal);
    const habitos = normalizeLongText(payload?.HabitosDeVida ?? payload?.habitosDeVida);
    const histAtual = normalizeLongText(payload?.HistoriaAtual ?? payload?.historiaAtual);
    const histPregressa = normalizeLongText(payload?.HistoriaPregressa ?? payload?.historiaPregressa);
    const antPessoais = normalizeLongText(payload?.AntecedentesPessoais ?? payload?.antecedentesPessoais);
    const antFamiliares = normalizeLongText(payload?.AntecedentesFamiliares ?? payload?.antecedentesFamiliares);
    const tratRealizados = normalizeLongText(payload?.TratamentosRealizados ?? payload?.tratamentosRealizados);
    const exameFisico = normalizeLongText(payload?.ExameClinicoFisico ?? payload?.exameClinicoFisico);
    const examesCompl = normalizeLongText(payload?.ExamesComplementares ?? payload?.examesComplementares);
    const diagFisio = normalizeLongText(payload?.DiagnosticoFisioterapeutico ?? payload?.diagnosticoFisioterapeutico);
    const progFisio = normalizeLongText(payload?.PrognosticoFisioterapeutico ?? payload?.prognosticoFisioterapeutico);
    const planoDet = normalizeLongText(payload?.PlanoTerapeuticoDetalhado ?? payload?.planoTerapeuticoDetalhado);

    const qtdProv = payload?.QuantidadeProvavelAtendimentos ?? payload?.quantidadeProvavelAtendimentos;
    const qtdProvVal =
      (qtdProv === undefined || qtdProv === null || String(qtdProv).trim() === '')
        ? null
        : assertInt(qtdProv, 'QuantidadeProvavelAtendimentos');

    const evolTexto = normalizeLongText(payload?.Evolucao ?? payload?.evolucao);
    const dataEvo = normalizeDateOnly(payload?.DataEvolucao ?? payload?.dataEvolucao);

    const interc = normalizeLongText(payload?.Intercorrencias ?? payload?.intercorrencias);

    try {
      const result = await queryWithContext(
        usuario,
        (req) => {
          req.input('PacienteId', sql.Int, pid);
          req.input('FisioterapeutaId', sql.Int, Number(usuario.id));

          // editáveis
          req.input('HistoriaClinica', sql.NVarChar(sql.MAX), historia);
          req.input('DetalhamentoCaso', sql.NVarChar(sql.MAX), detalhamento);
          req.input('PlanoTerapeutico', sql.NVarChar(sql.MAX), plano);

          req.input('QueixaPrincipal', sql.NVarChar(sql.MAX), queixa);
          req.input('HabitosDeVida', sql.NVarChar(sql.MAX), habitos);
          req.input('HistoriaAtual', sql.NVarChar(sql.MAX), histAtual);
          req.input('HistoriaPregressa', sql.NVarChar(sql.MAX), histPregressa);
          req.input('AntecedentesPessoais', sql.NVarChar(sql.MAX), antPessoais);
          req.input('AntecedentesFamiliares', sql.NVarChar(sql.MAX), antFamiliares);
          req.input('TratamentosRealizados', sql.NVarChar(sql.MAX), tratRealizados);
          req.input('ExameClinicoFisico', sql.NVarChar(sql.MAX), exameFisico);
          req.input('ExamesComplementares', sql.NVarChar(sql.MAX), examesCompl);
          req.input('DiagnosticoFisioterapeutico', sql.NVarChar(sql.MAX), diagFisio);
          req.input('PrognosticoFisioterapeutico', sql.NVarChar(sql.MAX), progFisio);
          req.input('PlanoTerapeuticoDetalhado', sql.NVarChar(sql.MAX), planoDet);
          req.input('QuantidadeProvavelAtendimentos', sql.Int, qtdProvVal);

          // evolução: no create, grava direto (se vier)
          req.input('EvolucaoTexto', sql.NVarChar(sql.MAX), evolTexto);
          req.input('DataEvolucao', sql.NVarChar(10), dataEvo); // converteremos para DATE no SQL
          req.input('Intercorrencias', sql.NVarChar(sql.MAX), interc);

          // snapshot automático
          req.input('PacienteNomeCompleto', sql.NVarChar(600), snap.PacienteNomeCompleto ?? null);
          req.input('PacienteNaturalidade', sql.NVarChar(240), snap.PacienteNaturalidade ?? null);
          req.input('PacienteEstadoCivil', sql.NVarChar(120), snap.PacienteEstadoCivil ?? null);
          req.input('PacienteGenero', sql.NVarChar(40), snap.PacienteGenero ?? null);
          req.input('PacienteLocalNascimento', sql.NVarChar(400), snap.PacienteLocalNascimento ?? null);
          req.input('PacienteDataNascimento', sql.Date, snap.PacienteDataNascimento ?? null);
          req.input('PacienteProfissao', sql.NVarChar(240), snap.PacienteProfissao ?? null);
          req.input('PacienteEnderecoResidencial', sql.NVarChar(1600), snap.ProntuarioEnderecoResidencial);
          req.input('PacienteEnderecoComercial', sql.NVarChar(1600), snap.ProntuarioEnderecoComercial);
          req.input('PacienteCep', sql.NVarChar(18), snap.PacienteCep ?? null);

          req.input('ProfissionalNome', sql.NVarChar(600), snap.ProfissionalNome ?? null);
          req.input('ProfissionalCrefito', sql.NVarChar(60), snap.ProfissionalCrefito ?? null);

          req.input('DataCriacao', sql.DateTime, snap.ProntuarioDataCriacao ?? null);
          req.input('DataRegistroProcedimentos', sql.DateTime2, snap.DataRegistroProcedimentos ?? null);
        },
        `
        INSERT INTO dbo.Prontuarios (
          PacienteId,
          FisioterapeutaId,

          HistoriaClinica,
          DetalhamentoCaso,
          PlanoTerapeutico,

          DataCriacao,
          DataUltimaAtualizacao,

          PacienteNomeCompleto,
          PacienteNaturalidade,
          PacienteEstadoCivil,
          PacienteGenero,
          PacienteLocalNascimento,
          PacienteDataNascimento,
          PacienteProfissao,
          PacienteEnderecoComercial,
          PacienteEnderecoResidencial,
          PacienteCep,

          QueixaPrincipal,
          HabitosDeVida,
          HistoriaAtual,
          HistoriaPregressa,
          AntecedentesPessoais,
          AntecedentesFamiliares,
          TratamentosRealizados,
          ExameClinicoFisico,
          ExamesComplementares,
          DiagnosticoFisioterapeutico,
          PrognosticoFisioterapeutico,
          PlanoTerapeuticoDetalhado,
          QuantidadeProvavelAtendimentos,

          Evolucao,
          DataEvolucao,
          Intercorrencias,

          ProfissionalNome,
          ProfissionalCrefito,
          DataRegistroProcedimentos
        )
        VALUES (
          @PacienteId,
          @FisioterapeutaId,

          @HistoriaClinica,
          @DetalhamentoCaso,
          @PlanoTerapeutico,

          @DataCriacao,
          SYSDATETIME(),

          @PacienteNomeCompleto,
          @PacienteNaturalidade,
          @PacienteEstadoCivil,
          @PacienteGenero,
          @PacienteLocalNascimento,
          @PacienteDataNascimento,
          @PacienteProfissao,
          @PacienteEnderecoComercial,
          @PacienteEnderecoResidencial,
          @PacienteCep,

          @QueixaPrincipal,
          @HabitosDeVida,
          @HistoriaAtual,
          @HistoriaPregressa,
          @AntecedentesPessoais,
          @AntecedentesFamiliares,
          @TratamentosRealizados,
          @ExameClinicoFisico,
          @ExamesComplementares,
          @DiagnosticoFisioterapeutico,
          @PrognosticoFisioterapeutico,
          @PlanoTerapeuticoDetalhado,
          @QuantidadeProvavelAtendimentos,

          @EvolucaoTexto,
          CASE WHEN @DataEvolucao IS NULL THEN NULL ELSE CAST(@DataEvolucao AS date) END,
          @Intercorrencias,

          @ProfissionalNome,
          @ProfissionalCrefito,
          @DataRegistroProcedimentos
        );

        DECLARE @NewId INT = CAST(SCOPE_IDENTITY() AS INT);

        SELECT TOP 1 *
        FROM dbo.Prontuarios
        WHERE Id = @NewId;
        `
      );

      const prontuario = result.recordset?.[0] || null;

      // opcional: sincroniza automáticos caso falte algo
      if (prontuario) {
        return await enriquecerProntuario(
          usuario,
          await sincronizarCamposAutomaticosDoProntuario(usuario, prontuario)
        );
      }

      return await enriquecerProntuario(usuario, prontuario);
    } catch (err) {
      // corrida com índice único (PacienteId, FisioterapeutaId)
      const n = err?.number || err?.originalError?.info?.number;
      const isDup = (n === 2627 || n === 2601 || /unique|duplicate/i.test(err?.message || ''));

      if (!isDup) throw err;

      const r2 = await queryWithContext(
        usuario,
        (req) => {
          req.input('PacienteId', sql.Int, pid);
          req.input('FisioterapeutaId', sql.Int, Number(usuario.id));
        },
        `
        SELECT TOP 1 *
        FROM dbo.Prontuarios
        WHERE PacienteId = @PacienteId
          AND FisioterapeutaId = @FisioterapeutaId
        ORDER BY DataUltimaAtualizacao DESC, Id DESC;
        `
      );

      const existente2 = r2.recordset?.[0] || null;
      if (existente2) {
        return await enriquecerProntuario(
          usuario,
          await sincronizarCamposAutomaticosDoProntuario(usuario, existente2)
        );
      }

      throw err;
    }
  },


  /**
   * PATCH atualiza prontuário existente
   * - DataUltimaAtualizacao sempre é atualizada
   * - Evolucao: quando enviado, APPENDA no texto com uma nova data
   */
  async atualizar(usuario, pacienteId, payload) {
  assertUser(usuario);
  const pid = assertInt(pacienteId, 'PacienteId');

  await assertFisioAtendeuPaciente(usuario, pid);

  const existente = await this._obterRaw(usuario, pid);
  if (!existente) throw new HttpError(404, 'Prontuário não encontrado para este paciente.');
  const estaAssinado = !!existente.AssinadoEm;

  // Campos editáveis (undefined = não mexe)
  // HistoriaClinica agora é APPEND (não sobrescreve)
  const histClinRaw = payload?.HistoriaClinica ?? payload?.historiaClinica;
  const histClinTexto = (histClinRaw === undefined) ? undefined : normalizeLongText(histClinRaw);
  const vaiAppendHistClin =
    histClinTexto !== undefined &&
    histClinTexto !== null &&
    String(histClinTexto).trim() !== '';

  const detalhamento = normalizeLongText(payload?.DetalhamentoCaso ?? payload?.detalhamentoCaso);
  const plano = normalizeLongText(payload?.PlanoTerapeutico ?? payload?.planoTerapeutico);

  const queixa = normalizeLongText(payload?.QueixaPrincipal ?? payload?.queixaPrincipal);
  const habitos = normalizeLongText(payload?.HabitosDeVida ?? payload?.habitosDeVida);
  const histAtual = normalizeLongText(payload?.HistoriaAtual ?? payload?.historiaAtual);
  const histPregressa = normalizeLongText(payload?.HistoriaPregressa ?? payload?.historiaPregressa);
  const antPessoais = normalizeLongText(payload?.AntecedentesPessoais ?? payload?.antecedentesPessoais);
  const antFamiliares = normalizeLongText(payload?.AntecedentesFamiliares ?? payload?.antecedentesFamiliares);

  // TratamentosRealizados agora é APPEND (não sobrescreve)
  const tratRealRaw = payload?.TratamentosRealizados ?? payload?.tratamentosRealizados;
  const tratRealTexto = (tratRealRaw === undefined) ? undefined : normalizeLongText(tratRealRaw);
  const vaiAppendTratReal =
    tratRealTexto !== undefined &&
    tratRealTexto !== null &&
    String(tratRealTexto).trim() !== '';

  const exameFisico = normalizeLongText(payload?.ExameClinicoFisico ?? payload?.exameClinicoFisico);
  const examesCompl = normalizeLongText(payload?.ExamesComplementares ?? payload?.examesComplementares);
  const diagFisio = normalizeLongText(payload?.DiagnosticoFisioterapeutico ?? payload?.diagnosticoFisioterapeutico);
  const progFisio = normalizeLongText(payload?.PrognosticoFisioterapeutico ?? payload?.prognosticoFisioterapeutico);
  const planoDet = normalizeLongText(payload?.PlanoTerapeuticoDetalhado ?? payload?.planoTerapeuticoDetalhado);

  const qtdProv = payload?.QuantidadeProvavelAtendimentos ?? payload?.quantidadeProvavelAtendimentos;
  const qtdProvVal = (qtdProv === undefined) ? undefined : (
    (qtdProv === null || String(qtdProv).trim() === '') ? null : assertInt(qtdProv, 'QuantidadeProvavelAtendimentos')
  );

  // Evolução (append) — só quando vier texto não-vazio
  const evolTextoRaw = payload?.Evolucao ?? payload?.evolucao;
  const evolTexto = (evolTextoRaw === undefined) ? undefined : normalizeLongText(evolTextoRaw);

  // Data base (pode vir no payload e ser usada por todos os "append")
  const dataEvo = normalizeDateOnly(payload?.DataEvolucao ?? payload?.dataEvolucao);

  const vaiAppendEvolucao =
    evolTexto !== undefined &&
    evolTexto !== null &&
    String(evolTexto).trim() !== '';

  // Intercorrências (append)
  const intercRaw = payload?.Intercorrencias ?? payload?.intercorrencias;
  const intercTexto = (intercRaw === undefined) ? undefined : normalizeLongText(intercRaw);

  const vaiAppendInterc =
    intercTexto !== undefined &&
    intercTexto !== null &&
    String(intercTexto).trim() !== '';

  // Se qualquer append precisar e não tiver data, usar hoje (YYYY-MM-DD)
  let dataEvoFinal = dataEvo;
  const ensureDataEvoFinal = () => {
    if (!dataEvoFinal) {
      const hoje = new Date();
      const yyyy = hoje.getFullYear();
      const mm = String(hoje.getMonth() + 1).padStart(2, '0');
      const dd = String(hoje.getDate()).padStart(2, '0');
      dataEvoFinal = `${yyyy}-${mm}-${dd}`;
    }
    return dataEvoFinal;
  };

  const normalizeForSuffix = (s) =>
    String(s ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trimEnd();

  const endsWithSameEntry = (colValue, entry) => {
    const a = normalizeForSuffix(colValue);
    const b = normalizeForSuffix(entry);
    return b.length > 0 && a.endsWith(b);
  };

  const sets = [];
  const inputs = [];

  const pushSet = (col, key, type, val) => {
    sets.push(`${col} = @${key}`);
    inputs.push({ k: key, t: type, v: val });
  };

  // Helper genérico de APPEND com data: [YYYY-MM-DD] texto
  // Só age se texto for não-vazio e a última entrada do campo ainda não for idêntica.
  const pushAppend = (col, textoKey, dataKey, existingValue, texto) => {
    if (texto === undefined || texto === null || String(texto).trim() === '') return;
    const d = ensureDataEvoFinal();
    const entry = `[${d}] ${texto}`;
    if (endsWithSameEntry(existingValue, entry)) return;
    inputs.push({ k: textoKey, t: sql.NVarChar(sql.MAX), v: texto });
    inputs.push({ k: dataKey,  t: sql.NVarChar(10),      v: d });
    sets.push(`
      ${col} =
        CASE
          WHEN LTRIM(RTRIM(ISNULL(${col}, N''))) = N'' THEN
            CONCAT(N'[', CONVERT(nvarchar(10), CAST(@${dataKey} AS date), 23), N'] ', @${textoKey})
          ELSE
            CONCAT(${col}, CHAR(13), CHAR(10), CHAR(13), CHAR(10),
                  N'[', CONVERT(nvarchar(10), CAST(@${dataKey} AS date), 23), N'] ', @${textoKey})
        END
    `.trim());
  };

  // Campos de texto — todos com semântica APPEND [data] + texto
  pushAppend('QueixaPrincipal',             'QueixaTexto',     'QueixaData',     existente.QueixaPrincipal,             queixa);
  pushAppend('HistoriaAtual',               'HistAtualTexto',  'HistAtualData',  existente.HistoriaAtual,               histAtual);
  pushAppend('HistoriaPregressa',           'HistPregTexto',   'HistPregData',   existente.HistoriaPregressa,           histPregressa);
  pushAppend('HabitosDeVida',               'HabitosTexto',    'HabitosData',    existente.HabitosDeVida,               habitos);
  pushAppend('AntecedentesPessoais',        'AntPessTexto',    'AntPessData',    existente.AntecedentesPessoais,        antPessoais);
  pushAppend('AntecedentesFamiliares',      'AntFamTexto',     'AntFamData',     existente.AntecedentesFamiliares,      antFamiliares);
  pushAppend('ExameClinicoFisico',          'ExameFisTexto',   'ExameFisData',   existente.ExameClinicoFisico,          exameFisico);
  pushAppend('ExamesComplementares',        'ExamesComplTexto','ExamesComplData', existente.ExamesComplementares,       examesCompl);
  pushAppend('DiagnosticoFisioterapeutico', 'DiagFisioTexto',  'DiagFisioData',  existente.DiagnosticoFisioterapeutico, diagFisio);
  pushAppend('PrognosticoFisioterapeutico', 'ProgFisioTexto',  'ProgFisioData',  existente.PrognosticoFisioterapeutico, progFisio);
  pushAppend('DetalhamentoCaso',            'DetalhTexto',     'DetalhData',     existente.DetalhamentoCaso,            detalhamento);
  pushAppend('PlanoTerapeutico',            'PlanoTexto',      'PlanoData',      existente.PlanoTerapeutico,            plano);
  pushAppend('PlanoTerapeuticoDetalhado',   'PlanoDetTexto',   'PlanoDetData',   existente.PlanoTerapeuticoDetalhado,   planoDet);

  // Campo numérico — semântica de substituição simples
  if (qtdProvVal !== undefined) pushSet('QuantidadeProvavelAtendimentos', 'QuantidadeProvavelAtendimentos', sql.Int, qtdProvVal);

  // APPEND: HistoriaClinica (idempotente se a última entrada for igual)
  if (vaiAppendHistClin) {
    const d = ensureDataEvoFinal();
    const entry = `[${d}] ${histClinTexto}`;

    if (!endsWithSameEntry(existente.HistoriaClinica, entry)) {
      inputs.push({ k: 'HistClinTexto', t: sql.NVarChar(sql.MAX), v: histClinTexto });
      inputs.push({ k: 'HistClinData', t: sql.NVarChar(10), v: d });

      sets.push(`
        HistoriaClinica =
          CASE
            WHEN LTRIM(RTRIM(ISNULL(HistoriaClinica, N''))) = N'' THEN
              CONCAT(N'[', CONVERT(nvarchar(10), CAST(@HistClinData AS date), 23), N'] ', @HistClinTexto)
            ELSE
              CONCAT(HistoriaClinica, CHAR(13), CHAR(10), CHAR(13), CHAR(10),
                    N'[', CONVERT(nvarchar(10), CAST(@HistClinData AS date), 23), N'] ', @HistClinTexto)
          END
      `.trim());
    }
  }

  // APPEND: TratamentosRealizados (idempotente se a última entrada for igual)
  if (vaiAppendTratReal) {
    const d = ensureDataEvoFinal();
    const entry = `[${d}] ${tratRealTexto}`;

    if (!endsWithSameEntry(existente.TratamentosRealizados, entry)) {
      inputs.push({ k: 'TratRealTexto', t: sql.NVarChar(sql.MAX), v: tratRealTexto });
      inputs.push({ k: 'TratRealData', t: sql.NVarChar(10), v: d });

      sets.push(`
        TratamentosRealizados =
          CASE
            WHEN LTRIM(RTRIM(ISNULL(TratamentosRealizados, N''))) = N'' THEN
              CONCAT(N'[', CONVERT(nvarchar(10), CAST(@TratRealData AS date), 23), N'] ', @TratRealTexto)
            ELSE
              CONCAT(TratamentosRealizados, CHAR(13), CHAR(10), CHAR(13), CHAR(10),
                    N'[', CONVERT(nvarchar(10), CAST(@TratRealData AS date), 23), N'] ', @TratRealTexto)
          END
      `.trim());
    }
  }

  // APPEND: Intercorrencias (idempotente se a última entrada for igual)
  if (vaiAppendInterc) {
    const d = ensureDataEvoFinal();
    const entry = `[${d}] ${intercTexto}`;

    if (!endsWithSameEntry(existente.Intercorrencias, entry)) {
      inputs.push({ k: 'IntercTexto', t: sql.NVarChar(sql.MAX), v: intercTexto });
      inputs.push({ k: 'IntercData', t: sql.NVarChar(10), v: d });

      sets.push(`
        Intercorrencias =
          CASE
            WHEN LTRIM(RTRIM(ISNULL(Intercorrencias, N''))) = N'' THEN
              CONCAT(N'[', CONVERT(nvarchar(10), CAST(@IntercData AS date), 23), N'] ', @IntercTexto)
            ELSE
              CONCAT(Intercorrencias, CHAR(13), CHAR(10), CHAR(13), CHAR(10),
                    N'[', CONVERT(nvarchar(10), CAST(@IntercData AS date), 23), N'] ', @IntercTexto)
          END
      `.trim());
    }
  }

  // APPEND: Evolucao (e atualiza DataEvolucao) — idempotente se a última entrada for igual
  if (vaiAppendEvolucao) {
    const d = ensureDataEvoFinal();
    const entry = `[${d}] ${evolTexto}`;

    if (!endsWithSameEntry(existente.Evolucao, entry)) {
      inputs.push({ k: 'EvolucaoTexto', t: sql.NVarChar(sql.MAX), v: evolTexto });
      inputs.push({ k: 'DataEvolucao', t: sql.NVarChar(10), v: d });

      sets.push(`
        Evolucao =
          CASE
            WHEN @EvolucaoTexto IS NULL OR LTRIM(RTRIM(@EvolucaoTexto)) = N'' THEN Evolucao
            WHEN LTRIM(RTRIM(ISNULL(Evolucao, N''))) = N'' THEN
              CONCAT(N'[', CONVERT(nvarchar(10), CAST(@DataEvolucao AS date), 23), N'] ', @EvolucaoTexto)
            ELSE
              CONCAT(Evolucao, CHAR(13), CHAR(10), CHAR(13), CHAR(10),
                    N'[', CONVERT(nvarchar(10), CAST(@DataEvolucao AS date), 23), N'] ', @EvolucaoTexto)
          END
      `.trim());

      sets.push(`
        DataEvolucao =
          CASE
            WHEN @EvolucaoTexto IS NULL OR LTRIM(RTRIM(@EvolucaoTexto)) = N'' THEN DataEvolucao
            ELSE CAST(@DataEvolucao AS date)
          END
      `.trim());
    }
  }

  if (estaAssinado && sets.length) {
    sets.push('AssinadoEm = NULL');
    sets.push('AssinadoPorId = NULL');
    sets.push('HashConteudo = NULL');
    sets.push('ProfissionalAssinatura = NULL');
  }

  // idempotente: se nada mudou (ex.: repetiu o mesmo texto), retorna o existente
  if (!sets.length) {
    return existente;
  }

  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('Id', sql.Int, existente.Id);
      req.input('FisioterapeutaId', sql.Int, Number(usuario.id));
      for (const i of inputs) req.input(i.k, i.t, i.v);
    },
    `
    UPDATE dbo.Prontuarios
    SET ${sets.join(', ')},
        DataUltimaAtualizacao = SYSDATETIME()
    WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;

    SELECT TOP 1 *
    FROM dbo.Prontuarios
    WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;
    `
  );

  const atualizado = result.recordset?.[0] || null;
  if (!atualizado) return null;
  return await enriquecerProntuario(
    usuario,
    await sincronizarCamposAutomaticosDoProntuario(usuario, atualizado)
  );
},

/**
 * POST /fisio/pacientes/:id/prontuario/assinar
 * Registra assinatura digital simples com rastreabilidade.
 */
async assinar(usuario, pacienteId, { ip = null } = {}) {
  assertUser(usuario);
  const pid = assertInt(pacienteId, 'PacienteId');

  await assertFisioAtendeuPaciente(usuario, pid);

  const prontuario = await this._obterRaw(usuario, pid);
  if (!prontuario) throw new HttpError(404, 'Prontuário não encontrado para este paciente.');

  if (prontuario.AssinadoEm && Number(prontuario.AssinadoPorId) === Number(usuario.id)) {
    return await enriquecerProntuario(usuario, prontuario);
  }

  const conteudoParaHash = JSON.stringify({
    Id: prontuario.Id,
    PacienteId: prontuario.PacienteId,
    FisioterapeutaId: prontuario.FisioterapeutaId,
    QueixaPrincipal: prontuario.QueixaPrincipal,
    HistoriaClinica: prontuario.HistoriaClinica,
    DiagnosticoFisioterapeutico: prontuario.DiagnosticoFisioterapeutico,
    PlanoTerapeutico: prontuario.PlanoTerapeutico,
    Evolucao: prontuario.Evolucao,
    DataUltimaAtualizacao: prontuario.DataUltimaAtualizacao,
  });
  const hash = createHash('sha256').update(conteudoParaHash, 'utf8').digest('hex');

  const ipNorm = ip ? String(ip).trim().slice(0, 120) : null;
  const fisioId = Number(usuario.id);

  const agora = new Date();
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const dataFormatada = formatter.format(agora).replace(',', '');
  const textoAssinatura = `${prontuario.ProfissionalNome ?? ''} - CREFITO ${prontuario.ProfissionalCrefito ?? ''} - ${dataFormatada}`.trim();

  const result = await queryWithContext(usuario, (req) => {
    req.input('Id', sql.Int, prontuario.Id);
    req.input('FisioterapeutaId', sql.Int, fisioId);
    req.input('AssinadoPorId', sql.Int, fisioId);
    req.input('HashConteudo', sql.NVarChar(64), hash);
    req.input('IpAssinatura', sql.NVarChar(120), ipNorm);
    req.input('ProfissionalAssinatura', sql.NVarChar(800), textoAssinatura);
  }, `
    UPDATE dbo.Prontuarios
    SET
      AssinadoEm = SYSDATETIME(),
      AssinadoPorId = @AssinadoPorId,
      HashConteudo = @HashConteudo,
      IpAssinatura = @IpAssinatura,
      ProfissionalAssinatura = @ProfissionalAssinatura,
      DataUltimaAtualizacao = SYSDATETIME()
    WHERE Id = @Id
      AND FisioterapeutaId = @FisioterapeutaId;

    SELECT TOP 1 *
    FROM dbo.Prontuarios
    WHERE Id = @Id
      AND FisioterapeutaId = @FisioterapeutaId;
  `);

  const atualizado = result.recordset?.[0] || null;
  if (!atualizado) throw new HttpError(500, 'Falha ao registrar assinatura.');
  return await enriquecerProntuario(usuario, atualizado);
},



  /**
   * GET download do prontuário em PDF (somente fisio, do paciente atendido)
   */
  async baixarPdf(usuario, pacienteId) {
    assertUser(usuario);
    const pid = assertInt(pacienteId, 'PacienteId');

    const prontuario = await enriquecerProntuario(usuario, await this._obterRaw(usuario, pid));
    if (!prontuario) throw new HttpError(404, 'Prontuário não encontrado para este paciente.');

    const estimatedTextBytes = estimateProntuarioPdfTextBytes(prontuario);
    if (estimatedTextBytes > MAX_PRONTUARIO_PDF_TEXT_BYTES) {
      throw new HttpError(413, 'Prontuário excede o limite permitido para exportação em PDF.');
    }

    const buffer = await gerarPdfBuffer(prontuario);

    const nomeSafe = toSafeSlug(
      trimOrNull(prontuario.PacienteNomeCompleto) || `paciente-${pid}`,
      `paciente-${pid}`
    );

    return {
      buffer,
      filename: `prontuario-${nomeSafe}.pdf`,
    };
  },

};

function formatDateTimeBR(v) {
  const d = parseDateOrNull(v);
  if (!d) return '-';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
}

function formatDateTimeBRCompact(v) {
  const d = parseDateOrNull(v);
  if (!d) return '-';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

function formatDateBR(v) {
  const d = parseDateOrNull(v);
  if (!d) return '-';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

const PRONTUARIO_PDF_COMPLETE_FIELDS = Object.freeze([
  'DataCriacao',
  'DataUltimaAtualizacao',
  'DataRegistroProcedimentos',
  'PacienteNomeCompleto',
  'PacienteNaturalidade',
  'PacienteEstadoCivil',
  'PacienteGenero',
  'PacienteLocalNascimento',
  'PacienteDataNascimento',
  'PacienteProfissao',
  'PacienteEnderecoComercial',
  'PacienteEnderecoResidencial',
  'PacienteCep',
  'PacienteCepComercial',
  'ProfissionalNome',
  'ProfissionalCrefito',
  'HistoriaClinica',
  'DetalhamentoCaso',
  'PlanoTerapeutico',
  'QueixaPrincipal',
  'HabitosDeVida',
  'HistoriaAtual',
  'HistoriaPregressa',
  'AntecedentesPessoais',
  'AntecedentesFamiliares',
  'TratamentosRealizados',
  'ExameClinicoFisico',
  'ExamesComplementares',
  'DiagnosticoFisioterapeutico',
  'PrognosticoFisioterapeutico',
  'PlanoTerapeuticoDetalhado',
  'QuantidadeProvavelAtendimentos',
  'Evolucao',
  'DataEvolucao',
  'Intercorrencias',
]);

const MAX_PRONTUARIO_PDF_TEXT_BYTES = 2_000_000; // ~2MB de texto agregado
const MAX_PRONTUARIO_PDF_BYTES = 10 * 1024 * 1024; // 10MB de PDF final

function estimateProntuarioPdfTextBytes(prontuario) {
  let total = 0;
  for (const k of PRONTUARIO_PDF_COMPLETE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(prontuario, k)) continue;
    const v = prontuario[k];
    if (v === null || v === undefined) continue;
    total += Buffer.byteLength(String(v), 'utf8');
  }
  return total;
}

function extractClinicalEntries(value) {
  const raw = trimOrNull(value);
  if (!raw) return [];

  const entries = [];
  const blocks = raw
    .split(/\r?\n\s*\r?\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const block of blocks) {
    const isoBracketMatch = block.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*([\s\S]*)$/);
    if (isoBracketMatch) {
      entries.push({
        date: formatDateBR(isoBracketMatch[1]),
        text: String(isoBracketMatch[2] ?? '').trim(),
      });
      continue;
    }

    const brDateMatch = block.match(/^(\d{2}\/\d{2}\/\d{4})(?:\s*\r?\n+|\s+)([\s\S]*)$/);
    if (brDateMatch) {
      entries.push({
        date: brDateMatch[1],
        text: String(brDateMatch[2] ?? '').trim(),
      });
      continue;
    }

    const isoDateMatch = block.match(/^(\d{4}-\d{2}-\d{2})(?:\s*\r?\n+|\s+)([\s\S]*)$/);
    if (isoDateMatch) {
      entries.push({
        date: formatDateBR(isoDateMatch[1]),
        text: String(isoDateMatch[2] ?? '').trim(),
      });
      continue;
    }

    if (block) {
      entries.push({ date: null, text: block });
    }
  }

  return entries.filter((entry) => trimOrNull(entry.text));
}

function gerarPdfBuffer(prontuario) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });

      const chunks = [];
      let totalBytes = 0;
      let settled = false;
      doc.on('data', (c) => {
        if (settled) return;
        totalBytes += c.length;
        if (totalBytes > MAX_PRONTUARIO_PDF_BYTES) {
          settled = true;
          reject(new HttpError(413, `PDF excede o limite permitido (${Math.round(MAX_PRONTUARIO_PDF_BYTES / 1024 / 1024)}MB).`));
          if (typeof doc.destroy === 'function') doc.destroy();
          return;
        }
        chunks.push(c);
      });
      doc.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      doc.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });

      const W = doc.page.width - 96;
      const PRIMARY = '#F46337';
      const DARK = '#1A1A1A';
      const MUTED = '#6B7280';
      const BORDER = '#E5E7EB';
      const BG_CARD = '#FFF9EE';
      const FOOTER_TEXT =
        'Este documento é um prontuário eletrônico gerado via plataforma FisioHelp. ' +
        'Ressaltamos que todo o conteúdo clínico, diagnóstico e condutas inseridas são de inteira ' +
        'e exclusiva responsabilidade do fisioterapeuta, que detém plena autonomia técnica ' +
        'e ética sobre o registro. A FisioHelp atua apenas como a ferramenta de suporte tecnológico ' +
        'para o armazenamento dos dados inseridos pelo profissional.';
      const FOOTER_HEIGHT = 96;
      const FOOTER_TOP = doc.page.height - FOOTER_HEIGHT;

      doc.rect(48, 40, W, 56).fill(PRIMARY);

      doc
        .fillColor('#FFFFFF')
        .fontSize(20)
        .font('Helvetica-Bold')
        .text('FisioHelp', 64, 52, { width: W - 32 });

      doc
        .fontSize(10)
        .font('Helvetica')
        .text('Prontuário do Paciente', 64, 76, { width: W - 32 });

      doc.y = 112;
      doc.fillColor(DARK);

      const idY = doc.y + 8;
      doc.rect(48, idY, W, 44).fill(BG_CARD).stroke(BORDER);

      const colW = W / 3;
      const labels = ['Prontuário', 'Paciente', 'Atualizado em'];
      const values = [
        prontuario.Id != null ? String(prontuario.Id) : '-',
        trimOrNull(prontuario.PacienteNomeCompleto) || '-',
        formatDateTimeBR(prontuario.DataUltimaAtualizacao || prontuario.DataCriacao || new Date()),
      ];

      labels.forEach((label, index) => {
        const x = 48 + index * colW + 12;
        doc
          .fillColor(MUTED)
          .fontSize(8)
          .font('Helvetica')
          .text(label, x, idY + 8, { width: colW - 16 });
        if (values[index]) {
          doc
            .fillColor(DARK)
            .fontSize(10)
            .font('Helvetica-Bold')
            .text(values[index], x, idY + 22, { width: colW - 16 });
        }
      });

      doc.y = idY + 60;

      const CONTENT_BOTTOM = FOOTER_TOP - 12;

      function drawFooter() {
        const footerY = FOOTER_TOP;
        const prevY = doc.y;
        doc.save();
        doc.moveTo(48, footerY).lineTo(48 + W, footerY).strokeColor(BORDER).stroke();
        doc
          .fillColor(MUTED)
          .fontSize(8)
          .font('Helvetica')
          .text(FOOTER_TEXT, 48, footerY + 6, {
            width: W,
            height: FOOTER_HEIGHT - 12,
            align: 'center',
          });
        doc.restore();
        doc.y = prevY;
      }

      drawFooter();
      doc.on('pageAdded', () => {
        drawFooter();
      });

      function ensureSpace(requiredHeight = 36) {
        if (doc.y + requiredHeight <= CONTENT_BOTTOM) return;
        doc.addPage();
        doc.y = 52;
        doc.fillColor(DARK);
      }

      function sectionTitle(title) {
        ensureSpace(28);
        doc.moveDown(0.5);
        doc
          .fillColor(DARK)
          .fontSize(11)
          .font('Helvetica-Bold')
          .text(title, 48, doc.y, { width: W });
        doc.moveTo(48, doc.y + 2).lineTo(48 + W, doc.y + 2).strokeColor(BORDER).stroke();
        doc.moveDown(0.45);
      }

      function fieldRow(label, value) {
        const safeValue = value || '-';
        doc.font('Helvetica').fontSize(9);
        const labelHeight = doc.heightOfString(label, { width: W / 2 - 8 });
        doc.font('Helvetica').fontSize(10);
        const valueHeight = doc.heightOfString(safeValue, { width: W / 2 });
        const rowHeight = Math.max(labelHeight, valueHeight) + 10;
        ensureSpace(rowHeight);

        const yy = doc.y;
        doc
          .fillColor(MUTED)
          .fontSize(9)
          .font('Helvetica')
          .text(label, 48, yy, { width: W / 2 - 8 });
        doc
          .fillColor(DARK)
          .fontSize(10)
          .font('Helvetica')
          .text(safeValue, 48 + W / 2, yy, { width: W / 2 });
        doc.y = yy + rowHeight;
      }

      function fieldRowFull(label, value) {
        const safeValue = value || '-';
        doc.font('Helvetica').fontSize(9);
        const labelHeight = doc.heightOfString(label, { width: W });
        doc.font('Helvetica').fontSize(10);
        const valueHeight = doc.heightOfString(safeValue, { width: W });
        const rowHeight = labelHeight + valueHeight + 12;
        ensureSpace(rowHeight);

        const yy = doc.y;
        doc
          .fillColor(MUTED)
          .fontSize(9)
          .font('Helvetica')
          .text(label, 48, yy, { width: W });
        doc
          .fillColor(DARK)
          .fontSize(10)
          .font('Helvetica')
          .text(safeValue, 48, yy + labelHeight + 4, { width: W, align: 'left' });
        doc.y = yy + rowHeight;
      }

      function signatureField(label, signatureValue, signedAtValue) {
        const safeSignature = trimOrNull(signatureValue) || '-';
        const safeSignedAt = trimOrNull(signedAtValue);

        doc.font('Helvetica').fontSize(9);
        const labelHeight = doc.heightOfString(label, { width: W });
        doc.font('Helvetica').fontSize(10);
        const signatureHeight = doc.heightOfString(safeSignature, { width: W });
        const signedAtHeight = safeSignedAt
          ? doc.heightOfString(safeSignedAt, { width: W })
          : 0;
        const rowHeight =
          labelHeight + signatureHeight + (safeSignedAt ? signedAtHeight + 8 : 4) + 8;
        ensureSpace(rowHeight);

        const yy = doc.y;
        doc
          .fillColor(MUTED)
          .fontSize(9)
          .font('Helvetica')
          .text(label, 48, yy, { width: W });
        doc
          .fillColor(DARK)
          .fontSize(10)
          .font('Helvetica')
          .text(safeSignature, 48, yy + labelHeight + 4, { width: W, align: 'left' });

        if (safeSignedAt) {
          doc
            .fillColor(PRIMARY)
            .fontSize(9)
            .font('Helvetica')
            .text(
              safeSignedAt,
              48,
              yy + labelHeight + 4 + signatureHeight + 4,
              { width: W, align: 'left' }
            );
        }

        doc.y = yy + rowHeight;
      }

      function clinicalSection(title, value) {
        const entries = extractClinicalEntries(value);
        sectionTitle(title);
        if (!entries.length) {
          ensureSpace(26);
          doc
            .fillColor(MUTED)
            .fontSize(10)
            .font('Helvetica')
            .text('Não preenchido', 48, doc.y, { width: W, align: 'left' });
          doc.moveDown(0.55);
          return;
        }
        entries.forEach((entry, index) => {
          const entryDate = entry.date || '';
          doc.font('Helvetica').fontSize(8);
          const dateHeight = entryDate ? doc.heightOfString(entryDate, { width: W }) + 4 : 0;
          doc.font('Helvetica').fontSize(10);
          const textHeight = doc.heightOfString(entry.text || '-', { width: W });
          const blockHeight = dateHeight + textHeight + (index < entries.length - 1 ? 14 : 10);
          ensureSpace(blockHeight);
          if (entry.date) {
            doc
              .fillColor(MUTED)
              .fontSize(8)
              .font('Helvetica')
              .text(entry.date, 48, doc.y, { width: W });
            doc.moveDown(0.15);
          }
          doc
            .fillColor(DARK)
            .fontSize(10)
            .font('Helvetica')
            .text(entry.text || '-', 48, doc.y, { width: W, align: 'left' });
          doc.moveDown(index < entries.length - 1 ? 0.85 : 0.55);
        });
      }

      sectionTitle('Informações do paciente');
      fieldRow('Nome completo', trimOrNull(prontuario.PacienteNomeCompleto) || '-');
      fieldRow('Naturalidade', trimOrNull(prontuario.PacienteNaturalidade) || '-');
      fieldRow('Estado civil', trimOrNull(prontuario.PacienteEstadoCivil) || '-');
      fieldRow('Gênero', trimOrNull(prontuario.PacienteGenero) || '-');
      fieldRow('Local de nascimento', trimOrNull(prontuario.PacienteLocalNascimento) || '-');
      fieldRow('Data de nascimento', formatDateBR(prontuario.PacienteDataNascimento));
      fieldRow('Profissão', trimOrNull(prontuario.PacienteProfissao) || '-');
      fieldRow('Endereço residencial', trimOrNull(prontuario.PacienteEnderecoResidencial) || '-');
      fieldRow('CEP', trimOrNull(prontuario.PacienteCep) || '-');
      fieldRow('Endereço comercial', trimOrNull(prontuario.PacienteEnderecoComercial) || '-');
      fieldRow('CEP comercial', trimOrNull(prontuario.PacienteCepComercial) || '-');

      clinicalSection('Queixa principal', prontuario.QueixaPrincipal);
      clinicalSection('História clínica', prontuario.HistoriaClinica);
      clinicalSection('Detalhamento do caso', prontuario.DetalhamentoCaso);
      clinicalSection('Plano terapêutico', prontuario.PlanoTerapeutico);
      clinicalSection('Hábitos de vida', prontuario.HabitosDeVida);
      clinicalSection('História atual', prontuario.HistoriaAtual);
      clinicalSection('História pregressa', prontuario.HistoriaPregressa);
      clinicalSection('Antecedentes pessoais', prontuario.AntecedentesPessoais);
      clinicalSection('Antecedentes familiares', prontuario.AntecedentesFamiliares);
      clinicalSection('Tratamentos realizados', prontuario.TratamentosRealizados);
      clinicalSection('Exame clínico físico', prontuario.ExameClinicoFisico);
      clinicalSection('Exames complementares', prontuario.ExamesComplementares);
      clinicalSection('Diagnóstico fisioterapêutico', prontuario.DiagnosticoFisioterapeutico);
      clinicalSection('Prognóstico fisioterapêutico', prontuario.PrognosticoFisioterapeutico);
      clinicalSection('Plano terapêutico detalhado', prontuario.PlanoTerapeuticoDetalhado);
      clinicalSection('Evolução', prontuario.Evolucao);
      clinicalSection('Intercorrências', prontuario.Intercorrencias);

      sectionTitle('Identificação do prontuário');
      fieldRow('Prontuário', prontuario.Id != null ? String(prontuario.Id) : '-');
      fieldRow('Criado em', formatDateTimeBR(prontuario.DataCriacao));
      fieldRow('Última atualização', formatDateTimeBR(prontuario.DataUltimaAtualizacao));
      fieldRow('Registro de procedimentos', formatDateTimeBR(prontuario.DataRegistroProcedimentos));
      fieldRowFull('Data da evolução', formatDateBR(prontuario.DataEvolucao));

      sectionTitle('Profissional responsável');
      fieldRow('Nome', trimOrNull(prontuario.ProfissionalNome) || '-');
      fieldRow('CREFITO', trimOrNull(prontuario.ProfissionalCrefito) || '-');
      signatureField(
        'Assinatura',
        prontuario.ProfissionalAssinatura,
        prontuario.AssinadoEm
          ? `Assinado digitalmente em ${formatDateTimeBRCompact(prontuario.AssinadoEm)}`
          : null
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

export default prontuariosService;
