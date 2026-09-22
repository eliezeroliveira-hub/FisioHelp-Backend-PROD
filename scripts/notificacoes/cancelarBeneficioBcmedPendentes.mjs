import 'dotenv/config';

import getPool, { sql } from '../../config/dbConfig.js';
import { queryWithContext } from '../../services/_queryWithContext.js';
import { BCMED_DADOS_TIPO } from '../../utils/beneficioBcmedCampaign.js';

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

const execute = process.argv.includes('--execute');
const campaignId = requiredArgument('campaign-id');
const expectedDatabase = requiredArgument('expected-database');
const actualDatabase = String(process.env.DB_NAME || '').trim();

if (!actualDatabase || actualDatabase.toLowerCase() !== expectedDatabase.toLowerCase()) {
  throw new Error(
    `Banco recusado: DB_NAME não corresponde a --expected-database (${expectedDatabase}).`
  );
}

if (!/^[a-z0-9-]{3,60}$/.test(campaignId)) {
  throw new Error('O campaign-id não corresponde a [a-z0-9-]{3,60}.');
}

if (execute && readArgument('confirm-campaign-id') !== campaignId) {
  throw new Error(
    'Para executar, informe --confirm-campaign-id com o mesmo valor de --campaign-id.'
  );
}

const usuario = {
  tipo: 'Admin',
  id: Number(process.env.SYSTEM_ADMIN_ID || 1),
};

async function consultarPendentes() {
  return queryWithContext(
    usuario,
    (req) => {
      req.input('DadosTipo', sql.NVarChar(100), BCMED_DADOS_TIPO);
      req.input('CampanhaId', sql.NVarChar(60), campaignId);
    },
    `
      SELECT Canal, Status, COUNT_BIG(1) AS Total
      FROM dbo.FilaNotificacoes fn
      WHERE fn.Status IN (N'Pendente', N'FalhaTemporaria')
        AND CASE
          WHEN ISJSON(fn.DadosJson) = 1 THEN JSON_VALUE(fn.DadosJson, '$.tipo')
        END = @DadosTipo
        AND CASE
          WHEN ISJSON(fn.DadosJson) = 1 THEN JSON_VALUE(fn.DadosJson, '$.campanhaId')
        END = @CampanhaId
      GROUP BY Canal, Status
      ORDER BY Canal, Status;
    `,
    { requireContext: true }
  );
}

async function cancelarPendentes() {
  return queryWithContext(
    usuario,
    (req) => {
      req.input('DadosTipo', sql.NVarChar(100), BCMED_DADOS_TIPO);
      req.input('CampanhaId', sql.NVarChar(60), campaignId);
    },
    `
      UPDATE fn
      SET
        fn.Status = N'FalhaDefinitiva',
        fn.UltimoErro = N'Campanha BCMED cancelada administrativamente.',
        fn.ProcessandoEm = NULL,
        fn.AtualizadoEm = SYSDATETIME()
      FROM dbo.FilaNotificacoes fn
      WHERE fn.Status IN (N'Pendente', N'FalhaTemporaria')
        AND CASE
          WHEN ISJSON(fn.DadosJson) = 1 THEN JSON_VALUE(fn.DadosJson, '$.tipo')
        END = @DadosTipo
        AND CASE
          WHEN ISJSON(fn.DadosJson) = 1 THEN JSON_VALUE(fn.DadosJson, '$.campanhaId')
        END = @CampanhaId;

      SELECT @@ROWCOUNT AS Cancelados;
    `,
    { requireContext: true }
  );
}

let pool;
try {
  pool = await getPool();
  const preview = await consultarPendentes();
  console.table(preview.recordset || []);

  if (!execute) {
    console.log('Dry-run concluído. Nenhuma linha foi alterada.');
  } else {
    const result = await cancelarPendentes();
    console.log(
      `Cancelamento concluído: ${Number(result.recordset?.[0]?.Cancelados || 0)} item(ns).`
    );
  }
} finally {
  await pool?.close();
}
