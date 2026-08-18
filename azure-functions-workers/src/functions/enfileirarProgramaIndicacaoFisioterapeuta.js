import { app } from '@azure/functions';
import { runDynamicWorkerTick } from '../shared/runWorkerTick.js';

app.timer('enfileirarProgramaIndicacaoFisioterapeuta', {
  schedule: '0 0 12 1 * *',
  runOnStartup: true,
  useMonitor: true,
  handler: async (_timer, context) => runDynamicWorkerTick({
    name: 'enfileirarProgramaIndicacaoFisioterapeuta',
    importer: () => import('../../workers/programaIndicacaoFisioterapeutaWorker.js'),
  }, context),
});