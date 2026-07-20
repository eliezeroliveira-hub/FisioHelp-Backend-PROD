import { app } from '@azure/functions';
import { runSqlJob } from '../shared/jobRunner.js';

app.timer('verificarConsultasExpiradas', {
  schedule: '0 */5 * * * *',
  handler: async (_timer, context) => runSqlJob({
    jobName: 'Verificar_ConsultasExpiradas',
    execute: async ({ pool, sql, agoraBrasil }) => {
      await pool.request()
        .input('HorasSemConfirmacao', sql.Int, 2)
        .input('AgoraBrasil', sql.DateTime2(7), agoraBrasil)
        .execute('dbo.SP_VerificarConsultasExpiradas');
    },
  }, context),
});
