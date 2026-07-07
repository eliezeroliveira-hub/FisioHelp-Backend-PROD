import { app } from '@azure/functions';
import { runDynamicWorkerTick } from '../shared/runWorkerTick.js';

app.timer('processarFilaContatoTransacional', {
  schedule: '0 */1 * * * *',
  handler: async (_timer, context) => runDynamicWorkerTick({
    name: 'processarFilaContatoTransacional',
    importer: () => import('../../workers/contatoTransacionalWorker.js'),
  }, context),
});
