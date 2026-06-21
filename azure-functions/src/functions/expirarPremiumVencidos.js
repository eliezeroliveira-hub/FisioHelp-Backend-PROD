import { app } from '@azure/functions';
import { runSqlJob } from '../shared/jobRunner.js';

// Azure Timer usa UTC. 04:00 UTC equivale a 01:00 em Brasilia hoje.
// Revisar este NCRONTAB se o Brasil voltar a adotar horario de verao.
app.timer('expirarPremiumVencidos', {
  schedule: '0 0 4 * * *',
  handler: async (_timer, context) => runSqlJob({
    jobName: 'Expirar Premium Vencidos',
    execute: async ({ pool, sql, agoraBrasil }) => {
      await pool.request()
        .input('AgoraBrasil', sql.DateTime2(7), agoraBrasil)
        .execute('dbo.sp_ExpirarPremiumVencidos');
    },
  }, context),
});
