import { app } from '@azure/functions';
import { runSqlJob } from '../shared/jobRunner.js';

app.timer('atualizaCachesAutomatico', {
  // SQL Agent: a cada 10 minutos a partir de 03:00 BRT.
  // Timer no Azure usa UTC: 03:00-23:59 BRT => 06:00-02:59 UTC.
  schedule: '0 */10 0-2,6-23 * * *',
  handler: async (_timer, context) => runSqlJob({
    jobName: 'AtualizaCaches_Automatico',
    execute: async ({ pool }) => {
      const procedures = [
        'dbo.SP_AtualizarDashboardGerencial',
        'dbo.SP_AtualizarFisioAvaliacoesMedia',
        'dbo.SP_AtualizarFisioConsultasResumo',
        'dbo.SP_AtualizarFisioFinanceiroResumo',
        'dbo.SP_AtualizarFisioPerformanceMensal',
        'dbo.SP_AtualizarPipelineFinanceiro',
        'dbo.SP_AtualizarRetencaoPacientes',
        'dbo.SP_AtualizarCacheRankingFisioterapeutas',
        'dbo.SP_AtualizarFisioPerformanceMensalResumo',
      ];

      for (const procedure of procedures) {
        context.log(`[jobs] AtualizaCaches_Automatico: executando ${procedure}.`);
        await pool.request().execute(procedure);
      }
    },
  }, context),
});
