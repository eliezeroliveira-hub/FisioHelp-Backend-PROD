import 'dotenv/config';
import getPool, { sql } from '../config/dbConfig.js';
import { agoraBrasilDate, getAppTimeZone } from '../utils/appDateTime.js';

async function main() {
  const agoraBrasil = agoraBrasilDate();
  const pool = await getPool();

  const result = await pool.request()
    .input('AgoraBrasilParam', sql.DateTime2(7), agoraBrasil)
    .query(`
      SELECT
        DB_NAME() AS BancoAtual,
        @AgoraBrasilParam AS AgoraBrasilParam,
        SYSDATETIME() AS AgoraSql,
        SYSUTCDATETIME() AS AgoraUtc,
        DATEDIFF(MINUTE, @AgoraBrasilParam, SYSDATETIME()) AS DiffAgoraSqlMin,
        DATEDIFF(MINUTE, @AgoraBrasilParam, SYSUTCDATETIME()) AS DiffAgoraUtcMin;
    `);

  console.log(JSON.stringify({
    appTimeZone: getAppTimeZone(),
    resultado: result.recordset?.[0] ?? null,
  }, null, 2));

  await pool.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
