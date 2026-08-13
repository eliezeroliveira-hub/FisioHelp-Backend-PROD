import { app } from '@azure/functions';
import { runSqlJob } from '../shared/jobRunner.js';

app.timer('limparCadastrosFisioPendentes', {
  // Diariamente às 04:15 BRT (07:15 UTC).
  schedule: '0 15 7 * * *',
  handler: async (_timer, context) => runSqlJob({
    jobName: 'Limpar_Cadastros_Fisio_Pendentes',
    execute: async ({ pool, sql }) => {
      await pool.request()
        .input('RetencaoExpiradosDias', sql.Int, 7)
        .input('RetencaoConsumidosDias', sql.Int, 30)
        .execute('dbo.SP_LimparCadastrosFisioPendentes');
    },
  }, context),
});
