import { app } from '@azure/functions';
import { runSqlJob } from '../shared/jobRunner.js';

app.timer('purgeLogsAntigos', {
  // Diariamente 04:00 BRT = 07:00 UTC.
  schedule: '0 0 7 * * *',
  handler: async (_timer, context) => runSqlJob({
    jobName: 'Purge_Logs_Antigos',
    execute: async ({ pool, sql, agoraBrasil }) => {
      await pool.request()
        .input('AgoraBrasil', sql.DateTime2(7), agoraBrasil)
        .query(`
          DECLARE @Dias INT = 90;
          DECLARE @Cutoff DATETIME2(7) = DATEADD(DAY, -@Dias, @AgoraBrasil);

          IF OBJECT_ID('dbo.SeedLogs', 'U') IS NOT NULL
            DELETE FROM dbo.SeedLogs
            WHERE DataInicio < @Cutoff;

          IF OBJECT_ID('dbo.LogsFinanceiros', 'U') IS NOT NULL
            DELETE FROM dbo.LogsFinanceiros
            WHERE DataAcao < @Cutoff;
        `);
    },
  }, context),
});
