import { app } from '@azure/functions';
import { runSqlJob } from '../shared/jobRunner.js';

app.timer('processarRepassesSemanais', {
  // Segunda 02:00 BRT = segunda 05:00 UTC.
  schedule: '0 0 5 * * 1',
  handler: async (_timer, context) => runSqlJob({
    jobName: 'Processar_Repasses_Semanais',
    execute: async ({ pool, sql, agoraBrasil }) => {
      await pool.request()
        .input('HorasContestacao', sql.Int, 24)
        .input('AgoraBrasil', sql.DateTime2(7), agoraBrasil)
        .execute('dbo.SP_ProcessarRepassesSemanais');
    },
  }, context),
});
