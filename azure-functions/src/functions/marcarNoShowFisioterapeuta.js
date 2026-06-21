import { app } from '@azure/functions';
import { runSqlJob } from '../shared/jobRunner.js';

app.timer('marcarNoShowFisioterapeuta', {
  schedule: '0 */2 * * * *',
  handler: async (_timer, context) => runSqlJob({
    jobName: 'Marcar_NoShow_Fisioterapeuta',
    execute: async ({ pool, sql, agoraBrasil }) => {
      await pool.request()
        .input('JanelaMinutos', sql.Int, 10)
        .input('AgoraBrasil', sql.DateTime2(7), agoraBrasil)
        .execute('dbo.SP_MarcarNoShowFisioterapeuta');
    },
  }, context),
});
