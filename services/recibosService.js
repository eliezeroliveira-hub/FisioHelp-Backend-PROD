// 📁 services/recibosService.js
// Geração de recibos informativos (sem valor fiscal) 100% no backend.
// - Aguarda janela de contestação (default: 24h) após DataEncerramento
// - NÃO altera a consulta; apenas gera recibo quando ela já estiver Concluída e fora da janela de contestação
// - Gera PDF em uploads/recibos/<arquivo>.pdf e grava CaminhoArquivo relativo: recibos/<arquivo>.pdf

import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function horasAposConclusao() {
  const raw = process.env.RECIBO_HORAS_APOS_CONCLUSAO;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 24;
}

function formatDateTimeBR(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return String(dt);

  // IMPORTANT: SQL Server DATETIME/DATETIME2 não carrega timezone.
  // No node-mssql (useUTC padrão), esses valores chegam como Date em UTC
  // (ex.: 2025-12-30 12:00 no banco -> 2025-12-30T12:00:00.000Z).
  // Se formatarmos em America/Sao_Paulo, o JS aplica -03:00 e "vira" 09:00.
  // Aqui a intenção é mostrar exatamente o horário gravado no banco (wall-clock).
  return d.toLocaleString('pt-BR', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
}

function formatMoneyBRL(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const RECIBOS_DIR = path.join(UPLOADS_DIR, 'recibos');
const RECIBO_LAYOUT_VERSION_ATENDIMENTO = 'v4';
const RECIBO_LAYOUT_VERSION_REEMBOLSO = 'v5';
const pdfEmAndamento = new Map();

function resolveSafeUploadsPath(relativeOrAbsolutePath) {
  const relative = String(relativeOrAbsolutePath || '').replace(/^\/+/, '');
  const abs = path.resolve(UPLOADS_DIR, relative);
  const uploadsRoot = path.resolve(UPLOADS_DIR);
  const absNorm = path.normalize(abs);
  const rootNorm = path.normalize(uploadsRoot + path.sep);

  if (!(absNorm === path.normalize(uploadsRoot) || absNorm.startsWith(rootNorm))) {
    throw Object.assign(new Error('Caminho inválido.'), { httpStatus: 400 });
  }
  return abs;
}

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function fileExists(p) {
  try {
    await fs.promises.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function reciboLayoutVersion(tipoRecibo) {
  return isTipoReembolso(tipoRecibo)
    ? RECIBO_LAYOUT_VERSION_REEMBOLSO
    : RECIBO_LAYOUT_VERSION_ATENDIMENTO;
}

function isReciboLayoutAtual(relativeOrAbsolutePath, tipoRecibo) {
  const fileName = path.basename(String(relativeOrAbsolutePath || ''));
  return fileName.includes(`-${reciboLayoutVersion(tipoRecibo)}.pdf`);
}

function isTipoReembolso(tipoRecibo) {
  return ['ReembolsoConsulta', 'ReembolsoPacote'].includes(String(tipoRecibo || '').trim());
}

function tipoReciboLabel(tipoRecibo) {
  switch (String(tipoRecibo || '').trim()) {
    case 'ReembolsoConsulta':
      return 'Reembolso de consulta';
    case 'ReembolsoPacote':
      return 'Reembolso de pacote';
    default:
      return 'Atendimento';
  }
}

function motivoLegivel(motivo) {
  const raw = String(motivo || '').trim();
  if (!raw) return '-';

  const mapa = {
    NAO_VOU_USAR: 'Cancelamento solicitado pelo paciente.',
    ARREPENDIMENTO_7_DIAS: 'Cancelamento por arrependimento de 7 dias.',
  };

  const upper = raw.toUpperCase();
  if (mapa[upper]) return mapa[upper];

  if (/^[A-Z0-9_]+$/.test(raw)) {
    return raw
      .toLowerCase()
      .split('_')
      .filter(Boolean)
      .map((parte, index) => (index === 0 ? parte.charAt(0).toUpperCase() + parte.slice(1) : parte))
      .join(' ');
  }

  return raw;
}

function referenciaReembolso(detalhe) {
  if (String(detalhe?.TipoRecibo || '') === 'ReembolsoPacote') {
    return detalhe?.PacoteId ? `Pacote #${detalhe.PacoteId}` : 'Pacote';
  }

  const consultaRef = detalhe?.ConsultaReferenciaId || detalhe?.ConsultaId;
  return consultaRef ? `Consulta #${consultaRef}` : 'Consulta';
}

async function gerarPdfReciboAtendimento({
  reciboId,
  consultaId,
  pacienteNome,
  fisioterapeutaNome,
  fisioterapeutaCrefito,
  dataHoraAtendimento,
  valorConsulta,
  origemPagamento,
  statusPagamento,
  dataGeracao
}) {
  await ensureDir(RECIBOS_DIR);

  const fileName = `recibo-consulta-${consultaId}-r${reciboId}-${RECIBO_LAYOUT_VERSION_ATENDIMENTO}.pdf`;
  const relPath = `recibos/${fileName}`;
  const absPath = path.join(UPLOADS_DIR, relPath);

  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const stream = fs.createWriteStream(absPath);
  doc.pipe(stream);

  const W = doc.page.width - 96;
  const PRIMARY = '#F46337';
  const DARK = '#1A1A1A';
  const MUTED = '#6B7280';
  const BORDER = '#E5E7EB';
  const BG_CARD = '#FFF9EE';

  // ── CABEÇALHO ─────────────────────────────────────────────────
  doc.rect(48, 40, W, 56).fill(PRIMARY);

  doc
    .fillColor('#FFFFFF')
    .fontSize(20)
    .font('Helvetica-Bold')
    .text('FisioHelp', 64, 52, { width: W - 32 });

  doc
    .fontSize(10)
    .font('Helvetica')
    .text('Recibo de Atendimento (Informativo)', 64, 76, { width: W - 32 });

  doc.y = 112;
  doc.fillColor(DARK);

  // ── FAIXA DE IDENTIFICADORES ──────────────────────────────────
  const idY = doc.y + 8;
  doc.rect(48, idY, W, 52).fill(BG_CARD).stroke(BORDER);

  const colW = W / 4;
  const labels = ['Recibo', 'Consulta', 'Emitido em', 'Status de pagamento'];
  const values = [
    String(reciboId ?? '-'),
    String(consultaId ?? '-'),
    formatDateTimeBR(dataGeracao || new Date()),
    statusPagamento || '-'
  ];

  labels.forEach((lbl, i) => {
    const x = 48 + i * colW + 12;
    doc
      .fillColor(MUTED)
      .fontSize(9)
      .font('Helvetica')
      .text(lbl, x, idY + 8, { width: colW - 16 });

    const isStatus = i === 3;
    const statusColor =
      String(statusPagamento || '').toLowerCase() === 'pago' ? '#059669' : '#B91C1C';

    doc
      .fillColor(isStatus ? statusColor : DARK)
      .fontSize(11)
      .font('Helvetica-Bold')
      .text(values[i], x, idY + 26, { width: colW - 16 });
  });

  doc.y = idY + 64;

  // ── SEÇÃO: Dados do Atendimento ───────────────────────────────
  function sectionTitle(title) {
    doc.moveDown(0.5);
    doc
      .fillColor(DARK)
      .fontSize(11)
      .font('Helvetica-Bold')
      .text(title, 48, doc.y, { width: W });
    doc.moveTo(48, doc.y + 2).lineTo(48 + W, doc.y + 2).strokeColor(BORDER).stroke();
    doc.moveDown(0.4);
  }

  function fieldRow(label, value) {
    const yy = doc.y;
    doc
      .fillColor(MUTED)
      .fontSize(9)
      .font('Helvetica')
      .text(label, 48, yy, { width: W / 2 - 8, continued: false });
    doc
      .fillColor(DARK)
      .fontSize(10)
      .font('Helvetica')
      .text(value || '-', 48 + W / 2, yy, { width: W / 2 });
    doc.moveDown(0.35);
  }

  sectionTitle('Dados do Atendimento');
  fieldRow('Paciente', pacienteNome || '-');
  fieldRow('Data/Hora', formatDateTimeBR(dataHoraAtendimento) || '-');
  fieldRow('Fisioterapeuta', fisioterapeutaNome || '-');
  fieldRow('CREFITO', fisioterapeutaCrefito || '-');

  // ── SEÇÃO: Informações de Pagamento ──────────────────────────
  sectionTitle('Informações de Pagamento');
  fieldRow('Valor', formatMoneyBRL(valorConsulta) || '-');
  fieldRow('Origem do Pagamento', origemPagamento || '-');
  fieldRow('Status do Pagamento', statusPagamento || '-');
  fieldRow('Método', 'Via Plataforma');

  // ── RODAPÉ / DISCLAIMER ───────────────────────────────────────
  const footerY = doc.page.height - 80;
  doc.moveTo(48, footerY).lineTo(48 + W, footerY).strokeColor(BORDER).stroke();

  doc
    .fillColor(MUTED)
    .fontSize(8)
    .font('Helvetica')
    .text(
      'Este documento é um recibo informativo gerado pela plataforma FisioHelp, destinado apenas a ' +
        'comprovação interna do atendimento. Não possui valor fiscal e não substitui nota fiscal.',
      48,
      footerY + 8,
      { width: W, align: 'center' }
    );

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { relPath, absPath, fileName };
}

async function gerarPdfReciboReembolso(detalhe) {
  await ensureDir(RECIBOS_DIR);

  const tipo = String(detalhe?.TipoRecibo || '').trim();
  const refId = tipo === 'ReembolsoPacote'
    ? (detalhe?.PacoteId || detalhe?.Id)
    : (detalhe?.TransacaoId || detalhe?.Id);
  const escopo = tipo === 'ReembolsoPacote' ? 'pacote' : 'consulta';
  const fileName = `recibo-reembolso-${escopo}-${refId}-r${detalhe.Id}-${RECIBO_LAYOUT_VERSION_REEMBOLSO}.pdf`;
  const relPath = `recibos/${fileName}`;
  const absPath = path.join(UPLOADS_DIR, relPath);

  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const stream = fs.createWriteStream(absPath);
  doc.pipe(stream);

  const W = doc.page.width - 96;
  const PRIMARY = '#F46337';
  const DARK = '#1A1A1A';
  const MUTED = '#6B7280';
  const BORDER = '#E5E7EB';
  const BG_CARD = '#FFF9EE';
  const SUCCESS = '#059669';

  doc.rect(48, 40, W, 56).fill(PRIMARY);

  doc
    .fillColor('#FFFFFF')
    .fontSize(20)
    .font('Helvetica-Bold')
    .text('FisioHelp', 64, 52, { width: W - 32 });

  doc
    .fontSize(10)
    .font('Helvetica')
    .text('Comprovante de Reembolso (Informativo)', 64, 76, { width: W - 32 });

  doc.y = 112;
  doc.fillColor(DARK);

  const idY = doc.y + 8;
  doc.rect(48, idY, W, 52).fill(BG_CARD).stroke(BORDER);

  const colW = W / 4;
  const labels = ['Recibo', 'Tipo', 'Emitido em', 'Status'];
  const values = [
    String(detalhe?.Id ?? '-'),
    tipoReciboLabel(tipo),
    formatDateTimeBR(detalhe?.DataGeracao || new Date()),
    'Reembolsado'
  ];

  labels.forEach((lbl, i) => {
    const x = 48 + i * colW + 12;
    doc
      .fillColor(MUTED)
      .fontSize(9)
      .font('Helvetica')
      .text(lbl, x, idY + 8, { width: colW - 16 });

    doc
      .fillColor(i === 3 ? SUCCESS : DARK)
      .fontSize(11)
      .font('Helvetica-Bold')
      .text(values[i], x, idY + 26, { width: colW - 16 });
  });

  doc.y = idY + 64;

  function sectionTitle(title) {
    doc.moveDown(0.5);
    doc
      .fillColor(DARK)
      .fontSize(11)
      .font('Helvetica-Bold')
      .text(title, 48, doc.y, { width: W });
    doc.moveTo(48, doc.y + 2).lineTo(48 + W, doc.y + 2).strokeColor(BORDER).stroke();
    doc.moveDown(0.4);
  }

  function fieldRow(label, value) {
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
      .text(value || '-', 48 + W / 2, yy, { width: W / 2 });
    doc.moveDown(0.35);
  }

  const dataReembolso =
    detalhe?.DataEvento ||
    detalhe?.GatewayRefundConfirmadoEm ||
    detalhe?.DataGeracao ||
    new Date();

  sectionTitle('Dados do Reembolso');
  fieldRow('Paciente', detalhe?.PacienteNome || '-');
  fieldRow('Referência', referenciaReembolso(detalhe));
  fieldRow('Data do reembolso', formatDateTimeBR(dataReembolso) || '-');
  fieldRow('Valor estornado', formatMoneyBRL(detalhe?.ValorDocumento ?? detalhe?.ValorConsulta) || '-');
  fieldRow('Motivo', motivoLegivel(detalhe?.Descricao));

  sectionTitle(tipo === 'ReembolsoPacote' ? 'Dados do Pacote' : 'Dados da Consulta');
  fieldRow('Fisioterapeuta', detalhe?.FisioterapeutaNome || '-');
  fieldRow('CREFITO', detalhe?.FisioterapeutaCrefito || '-');

  if (tipo === 'ReembolsoPacote') {
    const totalConsultas = Number(detalhe?.QuantidadeConsultas);
    const totalUtilizado = Number(detalhe?.ConsultasUtilizadas);
    fieldRow('Total de consultas do pacote', Number.isFinite(totalConsultas) ? String(totalConsultas) : '-');
    fieldRow('Total utilizado', Number.isFinite(totalUtilizado) ? String(totalUtilizado) : '-');
    fieldRow('Especialidade', detalhe?.EspecialidadeNome || '-');
  } else {
    fieldRow('Data/Hora da consulta', formatDateTimeBR(detalhe?.DataHora) || '-');
    fieldRow('Especialidade', detalhe?.EspecialidadeNome || '-');
  }

  sectionTitle('Processamento');
  fieldRow('Processado por', 'Plataforma FisioHelp');
  fieldRow('Código de referência', detalhe?.CodigoReferencia || '-');

  const footerY = doc.page.height - 80;
  doc.moveTo(48, footerY).lineTo(48 + W, footerY).strokeColor(BORDER).stroke();

  doc
    .fillColor(MUTED)
    .fontSize(8)
    .font('Helvetica')
    .text(
      'Este documento é um comprovante informativo de reembolso gerado pela plataforma FisioHelp. ' +
        'Não possui valor fiscal e não substitui nota fiscal ou documento tributário.',
      48,
      footerY + 8,
      { width: W, align: 'center' }
    );

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { relPath, absPath, fileName };
}

async function getReciboDetalheParaPdf(usuario, pacienteId, reciboId) {
  const r = await queryWithContext(
    usuario,
    (req) =>
      req
        .input('PacienteId', sql.Int, pacienteId)
        .input('ReciboId', sql.Int, reciboId),
    `
    SELECT
      r.Id,
      r.PacienteId,
      r.ConsultaId,
      r.TransacaoId,
      r.PacoteId,
      r.TipoRecibo,
      r.CaminhoArquivo,
      r.DataGeracao,
      r.ValorDocumento,
      r.DataEvento,
      r.Descricao,
      r.CodigoReferencia,
      COALESCE(c.DataHora, ct.DataHora, pk.PagoEm, pk.DataCompra, r.DataEvento) AS DataHora,
      CASE
        WHEN r.TipoRecibo = N'ReembolsoPacote' THEN pk.Status
        ELSE COALESCE(c.Status, ct.Status)
      END AS StatusConsulta,
      CASE
        WHEN r.TipoRecibo IN (N'ReembolsoConsulta', N'ReembolsoPacote') THEN N'Reembolsado'
        ELSE COALESCE(c.StatusPagamento, ct.StatusPagamento)
      END AS StatusPagamento,
      COALESCE(
        r.ValorDocumento,
        c.ValorConsulta,
        t.GatewayRefundValor,
        t.ValorTotal,
        pk.GatewayRefundValor,
        pk.ValorPago,
        pk.ValorTotal
      ) AS ValorConsulta,
      CASE
        WHEN r.TipoRecibo IN (N'ReembolsoConsulta', N'ReembolsoPacote') THEN N'Reembolso'
        ELSE COALESCE(c.OrigemPagamento, ct.OrigemPagamento)
      END AS OrigemPagamento,
      p.Nome AS PacienteNome,
      f.Id AS FisioterapeutaId,
      f.Nome AS FisioterapeutaNome,
      f.CREFITO AS FisioterapeutaCrefito,
      pk.NomePacote AS PacoteNome,
      pk.QuantidadeConsultas,
      pk.ConsultasUtilizadas,
      e.Nome AS EspecialidadeNome,
      COALESCE(t.ConsultaId, c.Id, ct.Id) AS ConsultaReferenciaId
    FROM dbo.Recibos r
    LEFT JOIN dbo.Transacoes t ON t.Id = r.TransacaoId
    LEFT JOIN dbo.Consultas c ON c.Id = r.ConsultaId
    LEFT JOIN dbo.Consultas ct ON ct.Id = t.ConsultaId
    LEFT JOIN dbo.Pacotes pk ON pk.Id = r.PacoteId
    INNER JOIN dbo.Pacientes p ON p.Id = r.PacienteId
    LEFT JOIN dbo.Fisioterapeutas f
      ON f.Id = COALESCE(c.FisioterapeutaId, ct.FisioterapeutaId, pk.FisioterapeutaId)
    LEFT JOIN dbo.Especialidades e
      ON e.Id = COALESCE(c.EspecialidadeId, ct.EspecialidadeId, pk.EspecialidadeId)
    WHERE r.Id = @ReciboId AND r.PacienteId = @PacienteId;
    `
  );

  return r.recordset?.[0] || null;
}

async function garantirRecibosParaConsultasConcluidas(usuario, pacienteId) {
  const horas = horasAposConclusao();

  // Cria registros em dbo.Recibos para consultas concluídas (após janela) (se não existir)
  const inserted = await queryWithContext(
    usuario,
    (req) => req.input('PacienteId', sql.Int, pacienteId).input('Horas', sql.Int, horas),
    `
    DECLARE @Novos TABLE (ReciboId INT, ConsultaId INT);

    ;WITH Eligible AS (
      SELECT c.Id AS ConsultaId, c.PacienteId
      FROM dbo.Consultas c
      WHERE c.PacienteId = @PacienteId
        AND LTRIM(RTRIM(ISNULL(c.Status, N''))) = N'Concluída'
        AND ISNULL(c.ConfirmacaoAtendimento, 0) = 1
        AND c.DataEncerramento IS NOT NULL
        AND DATEADD(HOUR, @Horas, c.DataEncerramento) <= SYSDATETIME()
        AND c.DataContestacao IS NULL
    )
    INSERT INTO dbo.Recibos
      (PacienteId, ConsultaId, TipoRecibo, ValorDocumento, DataEvento, Descricao, CodigoReferencia)
    OUTPUT inserted.Id, inserted.ConsultaId INTO @Novos(ReciboId, ConsultaId)
    SELECT
      e.PacienteId,
      e.ConsultaId,
      N'Atendimento',
      c.ValorConsulta,
      c.DataEncerramento,
      N'Recibo de atendimento concluído.',
      CONCAT(N'CONSULTA_', e.ConsultaId)
    FROM Eligible e
    INNER JOIN dbo.Consultas c ON c.Id = e.ConsultaId
    WHERE NOT EXISTS (
      SELECT 1
      FROM dbo.Recibos r WITH (UPDLOCK, HOLDLOCK)
      WHERE r.ConsultaId = e.ConsultaId
    );

    SELECT ReciboId, ConsultaId FROM @Novos;
    `
  );

  return inserted.recordset || [];
}

async function garantirRecibosParaReembolsosGateway(usuario, pacienteId) {
  const inserted = await queryWithContext(
    usuario,
    (req) => req.input('PacienteId', sql.Int, pacienteId),
    `
    DECLARE @Novos TABLE (ReciboId INT NOT NULL);

    INSERT INTO dbo.Recibos
      (PacienteId, TipoRecibo, TransacaoId, ValorDocumento, DataEvento, Descricao, CodigoReferencia)
    OUTPUT inserted.Id INTO @Novos(ReciboId)
    SELECT
      t.PacienteId,
      N'ReembolsoConsulta',
      t.Id,
      COALESCE(t.GatewayRefundValor, t.ValorTotal),
      COALESCE(t.GatewayRefundConfirmadoEm, t.GatewayAtualizadoEm, t.DataConfirmacao, SYSDATETIME()),
      COALESCE(t.GatewayRefundDescricao, N'Reembolso de consulta.'),
      COALESCE(t.GatewayRefundId, t.GatewayPaymentId, t.CodigoTransacao, CONCAT(N'TRANSACAO_', t.Id))
    FROM dbo.Transacoes t
    WHERE t.PacienteId = @PacienteId
      AND LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Reembolsado'
      AND LTRIM(RTRIM(ISNULL(t.GatewayRefundStatus, N''))) = N'DONE'
      AND COALESCE(t.GatewayRefundValor, t.ValorTotal) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM dbo.Recibos r WITH (UPDLOCK, HOLDLOCK)
        WHERE r.TipoRecibo = N'ReembolsoConsulta'
          AND r.TransacaoId = t.Id
      );

    INSERT INTO dbo.Recibos
      (PacienteId, TipoRecibo, PacoteId, ValorDocumento, DataEvento, Descricao, CodigoReferencia)
    OUTPUT inserted.Id INTO @Novos(ReciboId)
    SELECT
      p.PacienteId,
      N'ReembolsoPacote',
      p.Id,
      COALESCE(p.GatewayRefundValor, p.ValorPago, p.ValorTotal),
      COALESCE(p.GatewayRefundConfirmadoEm, p.GatewayAtualizadoEm, p.CanceladoEm, SYSDATETIME()),
      COALESCE(p.GatewayRefundDescricao, N'Reembolso de pacote.'),
      COALESCE(p.GatewayRefundId, p.GatewayPaymentId, p.GatewayCheckoutId, CONCAT(N'PACOTE_', p.Id))
    FROM dbo.Pacotes p
    WHERE p.PacienteId = @PacienteId
      AND LTRIM(RTRIM(ISNULL(p.GatewayRefundStatus, N''))) = N'DONE'
      AND COALESCE(p.GatewayRefundValor, p.ValorPago, p.ValorTotal) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM dbo.Recibos r WITH (UPDLOCK, HOLDLOCK)
        WHERE r.TipoRecibo = N'ReembolsoPacote'
          AND r.PacoteId = p.Id
      );

    SELECT ReciboId FROM @Novos;
    `
  );

  return inserted.recordset || [];
}

async function gerarPdfSeNecessarioSemMutex(usuario, pacienteId, reciboId) {
  const detalhe = await getReciboDetalheParaPdf(usuario, pacienteId, reciboId);
  if (!detalhe) return null;

  // Se já tem caminho, arquivo existe e já está no layout atual, só devolve.
  if (detalhe.CaminhoArquivo && isReciboLayoutAtual(detalhe.CaminhoArquivo, detalhe.TipoRecibo)) {
    const abs = resolveSafeUploadsPath(detalhe.CaminhoArquivo);
    if (await fileExists(abs)) {
      return { absPath: abs, fileName: path.basename(abs), relPath: detalhe.CaminhoArquivo };
    }
  }

  const { relPath, absPath, fileName } = isTipoReembolso(detalhe.TipoRecibo)
    ? await gerarPdfReciboReembolso(detalhe)
    : await gerarPdfReciboAtendimento({
        reciboId: detalhe.Id,
        consultaId: detalhe.ConsultaId,
        pacienteNome: detalhe.PacienteNome,
        fisioterapeutaNome: detalhe.FisioterapeutaNome,
        fisioterapeutaCrefito: detalhe.FisioterapeutaCrefito,
        dataHoraAtendimento: detalhe.DataHora,
        valorConsulta: detalhe.ValorConsulta,
        origemPagamento: detalhe.OrigemPagamento,
        statusPagamento: detalhe.StatusPagamento,
        dataGeracao: detalhe.DataGeracao || new Date()
      });

  // Grava caminho relativo no banco (somente "recibos/<arquivo>.pdf")
  await queryWithContext(
    usuario,
    (req) =>
      req
        .input('PacienteId', sql.Int, pacienteId)
        .input('ReciboId', sql.Int, reciboId)
        .input('CaminhoArquivo', sql.NVarChar(510), relPath),
    `
    UPDATE dbo.Recibos
      SET CaminhoArquivo = @CaminhoArquivo,
          DataGeracao = ISNULL(DataGeracao, SYSDATETIME())
    WHERE Id = @ReciboId AND PacienteId = @PacienteId;
    `
  );

  return { absPath, fileName, relPath };
}

async function garantirPdfSeNecessario(usuario, pacienteId, reciboId) {
  const key = `${pacienteId}-${reciboId}`;
  if (pdfEmAndamento.has(key)) return pdfEmAndamento.get(key);

  const promise = gerarPdfSeNecessarioSemMutex(usuario, pacienteId, reciboId)
    .finally(() => {
      pdfEmAndamento.delete(key);
    });

  pdfEmAndamento.set(key, promise);
  return promise;
}

export default {
  // Lista recibos do paciente logado.
  // Antes, tenta "fechar" consultas elegíveis (24h sem contestação) e criar recibos automaticamente.
  async listar(usuario) {
    const pacienteId = toInt(usuario?.id);
    if (!pacienteId) throw Object.assign(new Error('Paciente inválido.'), { httpStatus: 400 });

    // Gera registros de recibos para consultas já elegíveis
    const novos = await garantirRecibosParaConsultasConcluidas(usuario, pacienteId);
    const novosReembolsos = await garantirRecibosParaReembolsosGateway(usuario, pacienteId);

    // Gera PDFs somente para os recibos recém-criados (evita custo em listagem)
    for (const it of [...novos, ...novosReembolsos]) {
      const rid = toInt(it?.ReciboId);
      if (rid) {
        try {
          await garantirPdfSeNecessario(usuario, pacienteId, rid);
        } catch {
          // Não quebra a listagem se falhar PDF — o /pdf pode regenerar depois.
        }
      }
    }

    const r = await queryWithContext(
      usuario,
      (req) => req.input('PacienteId', sql.Int, pacienteId),
      `
      SELECT
        r.Id,
        r.PacienteId,
        r.ConsultaId,
        r.TransacaoId,
        r.PacoteId,
        r.TipoRecibo,
        r.CaminhoArquivo,
        r.DataGeracao,
        r.ValorDocumento,
        r.DataEvento,
        r.Descricao,
        r.CodigoReferencia,
        COALESCE(c.DataHora, ct.DataHora, pk.PagoEm, pk.DataCompra, r.DataEvento) AS DataHora,
        CASE
          WHEN r.TipoRecibo = N'ReembolsoPacote' THEN pk.Status
          ELSE COALESCE(c.Status, ct.Status)
        END AS StatusConsulta,
        CASE
          WHEN r.TipoRecibo IN (N'ReembolsoConsulta', N'ReembolsoPacote') THEN N'Reembolsado'
          ELSE COALESCE(c.StatusPagamento, ct.StatusPagamento)
        END AS StatusPagamento,
        COALESCE(
          r.ValorDocumento,
          c.ValorConsulta,
          t.GatewayRefundValor,
          t.ValorTotal,
          pk.GatewayRefundValor,
          pk.ValorPago,
          pk.ValorTotal
        ) AS ValorConsulta,
        CASE
          WHEN r.TipoRecibo IN (N'ReembolsoConsulta', N'ReembolsoPacote') THEN N'Reembolso'
          ELSE COALESCE(c.OrigemPagamento, ct.OrigemPagamento)
        END AS OrigemPagamento,
        f.Id AS FisioterapeutaId,
        f.Nome AS FisioterapeutaNome,
        f.CREFITO AS FisioterapeutaCrefito,
        pk.NomePacote AS PacoteNome,
        pk.QuantidadeConsultas,
        pk.ConsultasUtilizadas,
        e.Nome AS EspecialidadeNome,
        COALESCE(t.ConsultaId, c.Id, ct.Id) AS ConsultaReferenciaId
      FROM dbo.Recibos r
      LEFT JOIN dbo.Transacoes t ON t.Id = r.TransacaoId
      LEFT JOIN dbo.Consultas c ON c.Id = r.ConsultaId
      LEFT JOIN dbo.Consultas ct ON ct.Id = t.ConsultaId
      LEFT JOIN dbo.Pacotes pk ON pk.Id = r.PacoteId
      LEFT JOIN dbo.Fisioterapeutas f
        ON f.Id = COALESCE(c.FisioterapeutaId, ct.FisioterapeutaId, pk.FisioterapeutaId)
      LEFT JOIN dbo.Especialidades e
        ON e.Id = COALESCE(c.EspecialidadeId, ct.EspecialidadeId, pk.EspecialidadeId)
      WHERE r.PacienteId = @PacienteId
      ORDER BY r.DataGeracao DESC, r.Id DESC;
      `
    );

    return r.recordset || [];
  },

  async detalhar(usuario, reciboId) {
    const pacienteId = toInt(usuario?.id);
    const rid = toInt(reciboId);
    if (!pacienteId) throw Object.assign(new Error('Paciente inválido.'), { httpStatus: 400 });
    if (!rid) throw Object.assign(new Error('Id inválido.'), { httpStatus: 400 });

    const r = await queryWithContext(
      usuario,
      (req) => req.input('PacienteId', sql.Int, pacienteId).input('ReciboId', sql.Int, rid),
      `
      SELECT
        r.Id,
        r.PacienteId,
        r.ConsultaId,
        r.TransacaoId,
        r.PacoteId,
        r.TipoRecibo,
        r.CaminhoArquivo,
        r.DataGeracao,
        r.ValorDocumento,
        r.DataEvento,
        r.Descricao,
        r.CodigoReferencia,
        COALESCE(c.DataHora, ct.DataHora, pk.PagoEm, pk.DataCompra, r.DataEvento) AS DataHora,
        CASE
          WHEN r.TipoRecibo = N'ReembolsoPacote' THEN pk.Status
          ELSE COALESCE(c.Status, ct.Status)
        END AS StatusConsulta,
        CASE
          WHEN r.TipoRecibo IN (N'ReembolsoConsulta', N'ReembolsoPacote') THEN N'Reembolsado'
          ELSE COALESCE(c.StatusPagamento, ct.StatusPagamento)
        END AS StatusPagamento,
        COALESCE(
          r.ValorDocumento,
          c.ValorConsulta,
          t.GatewayRefundValor,
          t.ValorTotal,
          pk.GatewayRefundValor,
          pk.ValorPago,
          pk.ValorTotal
        ) AS ValorConsulta,
        CASE
          WHEN r.TipoRecibo IN (N'ReembolsoConsulta', N'ReembolsoPacote') THEN N'Reembolso'
          ELSE COALESCE(c.OrigemPagamento, ct.OrigemPagamento)
        END AS OrigemPagamento,
        f.Id AS FisioterapeutaId,
        f.Nome AS FisioterapeutaNome,
        f.CREFITO AS FisioterapeutaCrefito,
        pk.NomePacote AS PacoteNome,
        pk.QuantidadeConsultas,
        pk.ConsultasUtilizadas,
        e.Nome AS EspecialidadeNome,
        COALESCE(t.ConsultaId, c.Id, ct.Id) AS ConsultaReferenciaId
      FROM dbo.Recibos r
      LEFT JOIN dbo.Transacoes t ON t.Id = r.TransacaoId
      LEFT JOIN dbo.Consultas c ON c.Id = r.ConsultaId
      LEFT JOIN dbo.Consultas ct ON ct.Id = t.ConsultaId
      LEFT JOIN dbo.Pacotes pk ON pk.Id = r.PacoteId
      LEFT JOIN dbo.Fisioterapeutas f
        ON f.Id = COALESCE(c.FisioterapeutaId, ct.FisioterapeutaId, pk.FisioterapeutaId)
      LEFT JOIN dbo.Especialidades e
        ON e.Id = COALESCE(c.EspecialidadeId, ct.EspecialidadeId, pk.EspecialidadeId)
      WHERE r.Id = @ReciboId AND r.PacienteId = @PacienteId;
      `
    );

    return r.recordset?.[0] || null;
  },

  // Garante que o PDF exista (gera e salva se necessário) e devolve caminho absoluto
  async obterPdf(usuario, reciboId) {
    const pacienteId = toInt(usuario?.id);
    const rid = toInt(reciboId);
    if (!pacienteId) throw Object.assign(new Error('Paciente inválido.'), { httpStatus: 400 });
    if (!rid) throw Object.assign(new Error('Id inválido.'), { httpStatus: 400 });

    // Se o recibo ainda não existe (caso raro), tenta gerar a partir da consultaId==reciboId? Não assume.
    const pdf = await garantirPdfSeNecessario(usuario, pacienteId, rid);
    return pdf; // null => não encontrado
  }
};
