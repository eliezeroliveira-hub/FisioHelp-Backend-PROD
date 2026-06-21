import { app } from '@azure/functions';
import { runSqlJob } from '../shared/jobRunner.js';

app.timer('processarPontosFisioterapeutas', {
  schedule: '0 */10 * * * *',
  handler: async (_timer, context) => runSqlJob({
    jobName: 'Processar Pontos Fisioterapeutas',
    execute: async ({ pool, sql, agoraBrasil }) => {
      await pool.request()
        .input('FalharEmErro', sql.Bit, true)
        .input('AgoraBrasil', sql.DateTime2(7), agoraBrasil)
        .execute('dbo.ProcessarFilaAtualizacaoPontos');
    },
  }, context),
});
