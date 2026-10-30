import 'dotenv/config';

import getPool from '../../config/dbConfig.js';

function readArgument(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

const expectedDatabase = String(readArgument('expected-database') || '').trim();
if (!expectedDatabase) throw new Error('Informe --expected-database.');
const actualDatabase = String(process.env.DB_NAME || '').trim();
if (!actualDatabase || actualDatabase.toLowerCase() !== expectedDatabase.toLowerCase()) {
  throw new Error(`Banco recusado: DB_NAME não corresponde a --expected-database (${expectedDatabase}).`);
}

let pool;
try {
  pool = await getPool();
  const result = await pool.request().query(`
    SELECT N'CheckoutsConsultaPendentes' AS Indicador, COUNT_BIG(1) AS Total
    FROM dbo.Transacoes t
    INNER JOIN dbo.Consultas c ON c.Id = t.ConsultaId
    WHERE LTRIM(RTRIM(ISNULL(t.Status, N''))) = N'Pendente'
      AND NULLIF(LTRIM(RTRIM(ISNULL(t.GatewayCheckoutId, t.CodigoTransacao))), N'') IS NOT NULL

    UNION ALL

    SELECT N'CheckoutsPacotePendentes', COUNT_BIG(1)
    FROM dbo.Pacotes p
    WHERE LTRIM(RTRIM(ISNULL(p.Status, N''))) = N'PendentePagamento'
      AND NULLIF(LTRIM(RTRIM(ISNULL(p.GatewayCheckoutId, N''))), N'') IS NOT NULL

    UNION ALL

    SELECT N'ReembolsosPendentes', COUNT_BIG(1)
    FROM dbo.FilaReembolsosGateway r
    WHERE LTRIM(RTRIM(ISNULL(r.Status, N''))) IN (N'Pendente', N'Processando', N'FalhaTemporaria')

    UNION ALL

    SELECT N'RepassesPendentes', COUNT_BIG(1)
    FROM dbo.Repasses r
    WHERE LTRIM(RTRIM(ISNULL(r.Status, N''))) IN (N'Pendente', N'Processando', N'FalhaTemporaria')

    UNION ALL

    SELECT N'LotesRepasseNoGateway', COUNT_BIG(1)
    FROM dbo.LotesRepassesGateway l
    WHERE LTRIM(RTRIM(ISNULL(l.Status, N''))) IN (N'Criado', N'Processando', N'EnviadoGateway', N'AguardandoConfirmacao');
  `);
  const rows = result.recordset || [];
  console.table(rows);
  const checkoutPending = rows
    .filter((row) => String(row.Indicador).startsWith('Checkouts'))
    .reduce((total, row) => total + Number(row.Total || 0), 0);
  if (process.argv.includes('--require-zero-checkouts') && checkoutPending > 0) {
    throw new Error(`Ativação recusada: ainda existem ${checkoutPending} checkout(s) pendente(s).`);
  }
} finally {
  await pool?.close();
}
