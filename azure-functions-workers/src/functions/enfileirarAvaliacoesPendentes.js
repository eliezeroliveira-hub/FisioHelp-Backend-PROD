import { app } from '@azure/functions';
import { runDynamicWorkerTick } from '../shared/runWorkerTick.js';

app.timer('enfileirarAvaliacoesPendentes', {
  schedule: '0 */10 * * * *',
  handler: async (_timer, context) => runDynamicWorkerTick({
    name: 'enfileirarAvaliacoesPendentes',
    importer: () => import('../../workers/avaliacoesPendentesWorker.js'),
  }, context),
});