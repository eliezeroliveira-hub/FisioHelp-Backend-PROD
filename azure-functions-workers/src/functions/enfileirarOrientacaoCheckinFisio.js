import { app } from '@azure/functions';
import { runDynamicWorkerTick } from '../shared/runWorkerTick.js';

app.timer('enfileirarOrientacaoCheckinFisio', {
  schedule: '0 */10 * * * *',
  handler: async (_timer, context) => runDynamicWorkerTick({
    name: 'enfileirarOrientacaoCheckinFisio',
    importer: () => import('../../workers/orientacaoCheckinFisioWorker.js'),
  }, context),
});
