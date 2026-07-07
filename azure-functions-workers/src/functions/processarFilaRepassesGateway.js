import { app } from '@azure/functions';
import { runDynamicWorkerTick } from '../shared/runWorkerTick.js';

app.timer('processarFilaRepassesGateway', {
  schedule: '0 */1 * * * *',
  handler: async (_timer, context) => runDynamicWorkerTick({
    name: 'processarFilaRepassesGateway',
    importer: () => import('../../workers/repassesGatewayWorker.js'),
  }, context),
});