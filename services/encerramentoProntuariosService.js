import { createHash, randomBytes } from 'node:crypto';

import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { gerarPdfBuffer } from './prontuariosService.js';

export const INVENTARIO_PRONTUARIOS_CONFIRMACAO =
  'INVENTARIAR-PRONTUARIOS-PROD-2026-11-03';
export const EXPORTACAO_PRONTUARIO_CONFIRMACAO =
  'EXPORTAR-PRONTUARIO-LOCAL-VALIDACAO-2026-11-03';

const MAX_PDF_POR_MENSAGEM = 6.5 * 1024 * 1024;

function usuarioSistema() {
  return { tipo: 'Admin', id: Number(process.env.SYSTEM_ADMIN_ID ?? 1) };
}

function flagAtiva(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function erroOperacional(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function documentoSenha(row) {
  const cnpj = digits(row?.FisioterapeutaCNPJ);
  if (cnpj.length === 14) return { value: cnpj, type: 'CNPJ' };

  const cpf = digits(row?.FisioterapeutaCPF);
  if (cpf.length === 11) return { value: cpf, type: 'CPF' };

  throw erroOperacional(
    'O fisioterapeuta responsável não possui CPF/CNPJ válido para proteger o PDF.',
    409
  );
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function looksLikeTest(row) {
  const text = [
    row?.FisioterapeutaNome,
    row?.FisioterapeutaEmail,
    row?.PacienteNome,
    row?.PacienteEmail,
  ]
    .map((value) => String(value ?? '').toLowerCase())
    .join(' ');

  return /(^|[\s+._-])(teste?|review|revis[aã]o|play-review)([\s+._-]|@|$)/i.test(text);
}

function classificar(row) {
  if (looksLikeTest(row)) {
    return {
      classificacao: 'RevisaoManual',
      motivoClassificacao: 'Nome ou e-mail tem marcador compatível com teste/revisão.',
    };
  }

  return {
    classificacao: 'Real',
    motivoClassificacao: 'Nenhum marcador de teste encontrado; exige conferência humana.',
  };
}

async function inventariar() {
  const result = await queryWithContext(
    usuarioSistema(),
    () => {},
    `
      SELECT
        pr.Id AS ProntuarioId,
        pr.FisioterapeutaId,
        pr.PacienteId,
        pr.DataCriacao,
        pr.DataUltimaAtualizacao,
        pr.AssinadoEm,
        f.Nome AS FisioterapeutaNome,
        f.Email AS FisioterapeutaEmail,
        f.TipoPessoa AS FisioterapeutaTipoPessoa,
        CASE
          WHEN f.CNPJ IS NOT NULL
            AND LEN(REPLACE(REPLACE(REPLACE(f.CNPJ, '.', ''), '/', ''), '-', '')) = 14
          THEN N'CNPJ'
          ELSE N'CPF'
        END AS DocumentoSenhaTipo,
        RIGHT(CASE
          WHEN f.CNPJ IS NOT NULL
            AND LEN(REPLACE(REPLACE(REPLACE(f.CNPJ, '.', ''), '/', ''), '-', '')) = 14
          THEN REPLACE(REPLACE(REPLACE(f.CNPJ, '.', ''), '/', ''), '-', '')
          ELSE REPLACE(REPLACE(f.CPF, '.', ''), '-', '')
        END, 4) AS DocumentoSenhaFinal,
        p.Nome AS PacienteNome,
        p.Email AS PacienteEmail,
        (SELECT COUNT_BIG(1)
         FROM dbo.Consultas c
         WHERE c.FisioterapeutaId = pr.FisioterapeutaId
           AND c.PacienteId = pr.PacienteId) AS ConsultasDoVinculo
      FROM dbo.Prontuarios pr
      INNER JOIN dbo.Fisioterapeutas f ON f.Id = pr.FisioterapeutaId
      INNER JOIN dbo.Pacientes p ON p.Id = pr.PacienteId
      ORDER BY f.Id, pr.Id;
    `,
    { requireContext: true }
  );

  const items = (result.recordset ?? []).map((row) => ({
    ...row,
    ConsultasDoVinculo: Number(row.ConsultasDoVinculo ?? 0),
    ...classificar(row),
    aprovadoParaExportacao: false,
    observacaoRevisao: '',
  }));
  const resumo = items.reduce((acc, item) => {
    acc[item.classificacao] = (acc[item.classificacao] ?? 0) + 1;
    return acc;
  }, {});

  return {
    schemaVersion: 1,
    geradoEm: new Date().toISOString(),
    aviso:
      'Revise cada linha. Somente prontuários reais devem ser exportados e nenhum arquivo será enviado automaticamente.',
    total: items.length,
    resumo,
    items,
  };
}

async function buscarProntuario(prontuarioId) {
  const result = await queryWithContext(
    usuarioSistema(),
    (req) => req.input('ProntuarioId', sql.Int, prontuarioId),
    `
      SELECT TOP (1)
        pr.*,
        f.Nome AS FisioterapeutaNome,
        f.Email AS FisioterapeutaEmail,
        f.CPF AS FisioterapeutaCPF,
        f.CNPJ AS FisioterapeutaCNPJ,
        p.Nome AS PacienteNome,
        p.Email AS PacienteEmail
      FROM dbo.Prontuarios pr
      INNER JOIN dbo.Fisioterapeutas f ON f.Id = pr.FisioterapeutaId
      INNER JOIN dbo.Pacientes p ON p.Id = pr.PacienteId
      WHERE pr.Id = @ProntuarioId;
    `,
    { requireContext: true }
  );

  return result.recordset?.[0] ?? null;
}

async function exportar(prontuarioId) {
  const id = Number(prontuarioId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroOperacional('Prontuário inválido.');
  }

  const row = await buscarProntuario(id);
  if (!row) throw erroOperacional('Prontuário não encontrado.', 404);

  const classificacao = classificar(row);
  if (classificacao.classificacao !== 'Real') {
    throw erroOperacional(
      'Prontuário marcado para revisão manual; exportação automática recusada.',
      409
    );
  }

  const password = documentoSenha(row);
  const buffer = await gerarPdfBuffer(row, {
    pdfVersion: '1.7ext3',
    userPassword: password.value,
    ownerPassword: randomBytes(32).toString('hex'),
    permissions: {
      printing: 'highResolution',
      modifying: false,
      copying: false,
      annotating: false,
      fillingForms: false,
      contentAccessibility: true,
      documentAssembly: false,
    },
  });

  if (!buffer.includes(Buffer.from('/Encrypt'))) {
    throw erroOperacional('O PDF foi gerado sem o dicionário de criptografia.', 500);
  }

  const filename = `prontuario-${row.Id}-paciente-${row.PacienteId}.pdf`;
  return {
    buffer,
    filename,
    prontuarioId: Number(row.Id),
    pacienteId: Number(row.PacienteId),
    fisioterapeutaId: Number(row.FisioterapeutaId),
    bytes: buffer.length,
    sha256: sha256(buffer),
    protegido: true,
    senhaTipo: password.type,
    senhaFinal: password.value.slice(-4),
    excedeLimiteEmailIndividual: buffer.length > MAX_PDF_POR_MENSAGEM,
  };
}

export async function executarOperacaoProntuariosEncerramento({
  acao,
  confirmacao,
  prontuarioId,
} = {}) {
  if (!flagAtiva(process.env.ENCERRAMENTO_PRONTUARIOS_ENABLED)) {
    throw erroOperacional('Operação de prontuários desativada.', 403);
  }

  const action = String(acao ?? '').trim().toLowerCase();
  if (action === 'inventariar') {
    if (String(confirmacao ?? '').trim() !== INVENTARIO_PRONTUARIOS_CONFIRMACAO) {
      throw erroOperacional('Confirmação de inventário inválida.', 403);
    }
    return { tipo: 'inventario', ...(await inventariar()) };
  }

  if (action === 'exportar') {
    if (String(confirmacao ?? '').trim() !== EXPORTACAO_PRONTUARIO_CONFIRMACAO) {
      throw erroOperacional('Confirmação de exportação inválida.', 403);
    }
    return { tipo: 'pdf', ...(await exportar(prontuarioId)) };
  }

  throw erroOperacional('Ação inválida. Use inventariar ou exportar.');
}

export default { executarOperacaoProntuariosEncerramento };
