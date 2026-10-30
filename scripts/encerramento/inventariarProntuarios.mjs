import 'dotenv/config';

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import getPool from '../../config/dbConfig.js';

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

function parseIds(value) {
  return new Set(String(value || '').split(',').map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0));
}

const expectedDatabase = requiredArgument('expected-database');
const actualDatabase = String(process.env.DB_NAME || '').trim();
if (!actualDatabase || actualDatabase.toLowerCase() !== expectedDatabase.toLowerCase()) {
  throw new Error(`Banco recusado: DB_NAME não corresponde a --expected-database (${expectedDatabase}).`);
}

const outputDir = path.resolve(requiredArgument('output-dir'));
const explicitTestFisioIds = parseIds(readArgument('test-fisio-ids'));
const explicitTestPacienteIds = parseIds(readArgument('test-paciente-ids'));
const outputFile = path.join(outputDir, 'inventario-prontuarios.json');

function looksLikeTest(row) {
  const text = [row.FisioterapeutaNome, row.FisioterapeutaEmail, row.PacienteNome, row.PacienteEmail]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
  return /(^|[\s+._-])(teste?|review|revis[aã]o|play-review)([\s+._-]|@|$)/i.test(text);
}

function classify(row) {
  if (explicitTestFisioIds.has(Number(row.FisioterapeutaId)) || explicitTestPacienteIds.has(Number(row.PacienteId))) {
    return { classificacao: 'Teste', motivoClassificacao: 'Identificador incluído explicitamente na lista de testes.' };
  }
  if (looksLikeTest(row)) {
    return { classificacao: 'RevisaoManual', motivoClassificacao: 'Nome ou e-mail tem marcador compatível com teste/revisão.' };
  }
  return { classificacao: 'Real', motivoClassificacao: 'Nenhum marcador de teste encontrado; exige conferência humana.' };
}

let pool;
try {
  pool = await getPool();
  const result = await pool.request().query(`
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
        WHEN f.CNPJ IS NOT NULL AND LEN(REPLACE(REPLACE(REPLACE(f.CNPJ, '.', ''), '/', ''), '-', '')) = 14 THEN N'CNPJ'
        ELSE N'CPF'
      END AS DocumentoSenhaTipo,
      RIGHT(CASE
        WHEN f.CNPJ IS NOT NULL AND LEN(REPLACE(REPLACE(REPLACE(f.CNPJ, '.', ''), '/', ''), '-', '')) = 14
          THEN REPLACE(REPLACE(REPLACE(f.CNPJ, '.', ''), '/', ''), '-', '')
        ELSE REPLACE(REPLACE(f.CPF, '.', ''), '-', '')
      END, 4) AS DocumentoSenhaFinal,
      p.Nome AS PacienteNome,
      p.Email AS PacienteEmail,
      (SELECT COUNT_BIG(1) FROM dbo.Consultas c WHERE c.FisioterapeutaId = pr.FisioterapeutaId AND c.PacienteId = pr.PacienteId) AS ConsultasDoVinculo
    FROM dbo.Prontuarios pr
    INNER JOIN dbo.Fisioterapeutas f ON f.Id = pr.FisioterapeutaId
    INNER JOIN dbo.Pacientes p ON p.Id = pr.PacienteId
    ORDER BY f.Id, pr.Id;
  `);

  const items = (result.recordset || []).map((row) => ({
    ...row,
    ...classify(row),
    aprovadoParaExportacao: false,
    observacaoRevisao: '',
  }));
  const resumo = items.reduce((acc, item) => {
    acc[item.classificacao] = (acc[item.classificacao] || 0) + 1;
    return acc;
  }, {});

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputFile, `${JSON.stringify({
    schemaVersion: 1,
    banco: expectedDatabase,
    geradoEm: new Date().toISOString(),
    aviso: 'Revise cada linha. Marque aprovadoParaExportacao=true somente para prontuários reais que devem ser entregues.',
    resumo,
    items,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

  console.table(Object.entries(resumo).map(([Classificacao, Total]) => ({ Classificacao, Total })));
  console.log(`Inventário gravado em ${outputFile}. Nenhum PDF foi gerado e nenhum e-mail foi enviado.`);
} finally {
  await pool?.close();
}
