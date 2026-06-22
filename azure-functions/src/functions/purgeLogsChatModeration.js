import { app } from '@azure/functions';
import { runSqlJob } from '../shared/jobRunner.js';

app.timer('purgeLogsChatModeration', {
  // Domingo 03:00 BRT = domingo 06:00 UTC.
  schedule: '0 0 6 * * 0',
  handler: async (_timer, context) => runSqlJob({
    jobName: 'Purge_Logs_ChatModeration',
    execute: async ({ pool, sql, agoraBrasil }) => {
      await pool.request()
        .input('AgoraBrasil', sql.DateTime2(7), agoraBrasil)
        .execute('dbo.SP_AtualizarAlertasReincidencia');

      await pool.request()
        .input('AgoraBrasil', sql.DateTime2(7), agoraBrasil)
        .execute('dbo.SP_LimparLogsChat');
    },
  }, context),
});