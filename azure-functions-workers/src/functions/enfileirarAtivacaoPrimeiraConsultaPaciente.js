import { app } from '@azure/functions';
import { runDynamicWorkerTick } from '../shared/runWorkerTick.js';

app.timer('enfileirarAtivacaoPrimeiraConsultaPaciente', {
  schedule: '0 25 * * * *',
  runOnStartup: false,
  useMonitor: true,
  handler: async (_timer, context) => runDynamicWorkerTick({
    name: 'enfileirarAtivacaoPrimeiraConsultaPaciente',
    importer: () => import('../../workers/pacientePrimeiraConsultaWorker.js'),
  }, context),
});
