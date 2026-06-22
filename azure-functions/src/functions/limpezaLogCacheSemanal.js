import { app } from '@azure/functions';
import { runSqlJob } from '../shared/jobRunner.js';

app.timer('limpezaLogCacheSemanal', {
  // Domingo 03:30 BRT = domingo 06:30 UTC.
  schedule: '0 30 6 * * 0',
  handler: async (_timer, context) => runSqlJob({
    jobName: 'Limpeza_LogCache_Semanal',
    execute: async ({ pool, sql, agoraBrasil }) => {
      await pool.request()
        .input('AgoraBrasil', sql.DateTime2(7), agoraBrasil)
        .query(`
          DECLARE @DiasRetencao INT = 90;
          DECLARE @Cutoff DATETIME2(7) = DATEADD(DAY, -@DiasRetencao, @AgoraBrasil);
          DECLARE @Batch INT = 20000;
          DECLARE @Rows INT = 1;

          WHILE (@Rows > 0)
          BEGIN
            DELETE TOP (@Batch)
            FROM cache.LogAtualizacaoCache
            WHERE DataAtualizacao < @Cutoff;

            SET @Rows = @@ROWCOUNT;
          END
        `);
    },
  }, context),
});
