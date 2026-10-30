import 'dotenv/config';

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import getPool, { sql } from '../../config/dbConfig.js';
import { gerarPdfBuffer } from '../../services/prontuariosService.js';

const MAX_PDF_POR_MENSAGEM = 6.5 * 1024 * 1024;

function readArgument(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function requiredArgument(name) {
  const value = String(readArgument(name) || '').trim();
  if (!value) throw new Error(`Informe --${name}.`);
  return value;
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function documentPassword(row) {
  const cnpj = digits(row.FisioterapeutaCNPJ);
  if (cnpj.length === 14) return { value: cnpj, type: 'CNPJ' };
  const cpf = digits(row.FisioterapeutaCPF);
  if (cpf.length === 11) return { value: cpf, type: 'CPF' };
  throw new Error(`Fisioterapeuta ${row.FisioterapeutaId} sem CPF/CNPJ válido para proteger o PDF.`);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const expectedDatabase = requiredArgument('expected-database');
const actualDatabase = String(process.env.DB_NAME || '').trim();
if (!actualDatabase || actualDatabase.toLowerCase() !== expectedDatabase.toLowerCase()) {
  throw new Error(`Banco recusado: DB_NAME não corresponde a --expected-database (${expectedDatabase}).`);
}

const selectionFile = path.resolve(requiredArgument('selection'));
const outputDir = path.resolve(requiredArgument('output-dir'));
const selection = JSON.parse(await readFile(selectionFile, 'utf8'));
if (String(selection.banco || '').toLowerCase() !== expectedDatabase.toLowerCase()) {
  throw new Error('O inventário pertence a outro banco de dados.');
}
const approvedIds = (selection.items || [])
  .filter((item) => item.aprovadoParaExportacao === true && item.classificacao === 'Real')
  .map((item) => Number(item.ProntuarioId))
  .filter((id) => Number.isInteger(id) && id > 0);
if (!approvedIds.length) throw new Error('Nenhum prontuário real foi aprovado no inventário.');

let pool;
try {
  pool = await getPool();
  const request = pool.request();
  request.input('IdsJson', sql.NVarChar(sql.MAX), JSON.stringify(approvedIds));
  const result = await request.query(`
    SELECT
      pr.*,
      f.Nome AS FisioterapeutaNomeExportacao,
      f.Email AS FisioterapeutaEmailExportacao,
      f.CPF AS FisioterapeutaCPF,
      f.CNPJ AS FisioterapeutaCNPJ
    FROM dbo.Prontuarios pr
    INNER JOIN dbo.Fisioterapeutas f ON f.Id = pr.FisioterapeutaId
    INNER JOIN OPENJSON(@IdsJson) ids ON TRY_CONVERT(int, ids.[value]) = pr.Id
    ORDER BY pr.FisioterapeutaId, pr.Id;
  `);
  const rows = result.recordset || [];
  if (rows.length !== new Set(approvedIds).size) {
    throw new Error(`Seleção inconsistente: ${approvedIds.length} ID(s) aprovados e ${rows.length} prontuário(s) encontrado(s).`);
  }

  await mkdir(outputDir, { recursive: true });
  const entries = [];
  for (const row of rows) {
    const password = documentPassword(row);
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
      throw new Error(`O PDF do prontuário ${row.Id} não contém dicionário de criptografia.`);
    }
    const fisioterapeutaDir = path.join(outputDir, `fisioterapeuta-${row.FisioterapeutaId}`);
    await mkdir(fisioterapeutaDir, { recursive: true });
    const filename = `prontuario-${row.Id}-paciente-${row.PacienteId}.pdf`;
    const file = path.join(fisioterapeutaDir, filename);
    await writeFile(file, buffer, { flag: 'wx' });
    entries.push({
      prontuarioId: Number(row.Id),
      pacienteId: Number(row.PacienteId),
      fisioterapeutaId: Number(row.FisioterapeutaId),
      destinatario: row.FisioterapeutaEmailExportacao,
      arquivo: path.relative(outputDir, file),
      bytes: buffer.length,
      sha256: sha256(buffer),
      protegido: true,
      senha: `${password.type} do fisioterapeuta, somente números (final ${password.value.slice(-4)})`,
      excedeLimiteEmailIndividual: buffer.length > MAX_PDF_POR_MENSAGEM,
    });
  }

  const groups = new Map();
  for (const entry of entries) {
    const list = groups.get(entry.fisioterapeutaId) || [];
    list.push(entry);
    groups.set(entry.fisioterapeutaId, list);
  }
  const lotesEmail = [];
  for (const [fisioterapeutaId, files] of groups) {
    let batch = { fisioterapeutaId, lote: 1, bytes: 0, arquivos: [] };
    for (const file of files) {
      if (batch.arquivos.length && batch.bytes + file.bytes > MAX_PDF_POR_MENSAGEM) {
        lotesEmail.push(batch);
        batch = { fisioterapeutaId, lote: batch.lote + 1, bytes: 0, arquivos: [] };
      }
      batch.arquivos.push(file.arquivo);
      batch.bytes += file.bytes;
    }
    if (batch.arquivos.length) lotesEmail.push(batch);
  }

  const manifestFile = path.join(outputDir, 'manifesto-exportacao.json');
  await writeFile(manifestFile, `${JSON.stringify({
    schemaVersion: 1,
    banco: expectedDatabase,
    geradoEm: new Date().toISOString(),
    limitePlanejadoPorEmailBytes: MAX_PDF_POR_MENSAGEM,
    aviso: 'Nenhuma senha completa é armazenada neste manifesto. Nenhum e-mail foi enviado.',
    arquivos: entries,
    lotesEmail,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

  console.log(`${entries.length} PDF(s) protegido(s) gerado(s) em ${outputDir}.`);
  console.log(`Manifesto SHA-256 e lotes de anexos: ${manifestFile}. Nenhum e-mail foi enviado.`);
} finally {
  await pool?.close();
}
