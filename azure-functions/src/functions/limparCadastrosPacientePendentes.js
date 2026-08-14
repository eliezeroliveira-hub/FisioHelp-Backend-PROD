import { app } from '@azure/functions';
import { runSqlJob } from '../shared/jobRunner.js';

app.timer('limparCadastrosPacientePendentes', {
  // Diariamente às 04:25 BRT (07:25 UTC), após a limpeza equivalente do fisio.
  schedule: '0 25 7 * * *',
  handler: async (_timer, context) => runSqlJob({
    jobName: 'Limpar_Cadastros_Paciente_Pendentes',
    execute: async ({ pool, sql }) => {
      await pool.request()
        .input('RetencaoExpiradosDias', sql.Int, 7)
        .input('RetencaoConsumidosDias', sql.Int, 30)
        .execute('dbo.SP_LimparCadastrosPacientePendentes');
    },
  }, context),
});
