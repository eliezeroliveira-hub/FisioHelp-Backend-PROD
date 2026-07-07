import { app } from '@azure/functions';
import { runDynamicWorkerTick } from '../shared/runWorkerTick.js';

app.timer('enfileirarLembretesConsulta', {
  schedule: '0 */10 * * * *',
  handler: async (_timer, context) => runDynamicWorkerTick({
    name: 'enfileirarLembretesConsulta',
    importer: () => import('../../workers/consultasLembretesWorker.js'),
  }, context),
});