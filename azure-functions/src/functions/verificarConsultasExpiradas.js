import { app } from '@azure/functions';
import { runSqlJob } from '../shared/jobRunner.js';

app.timer('verificarConsultasExpiradas', {
  schedule: '0 0 * * * *',
  handler: async (_timer, context) => runSqlJob({
    jobName: 'Verificar_ConsultasExpiradas',
    execute: async ({ pool, sql, agoraBrasil }) => {
      await pool.request()
        .input('HorasSemConfirmacao', sql.Int, 24)
        .input('AgoraBrasil', sql.DateTime2(7), agoraBrasil)
        .execute('dbo.SP_VerificarConsultasExpiradas');
    },
  }, context),
});
