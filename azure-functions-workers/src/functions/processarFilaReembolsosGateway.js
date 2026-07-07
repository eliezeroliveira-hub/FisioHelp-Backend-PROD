import { app } from '@azure/functions';
import { runDynamicWorkerTick } from '../shared/runWorkerTick.js';

app.timer('processarFilaReembolsosGateway', {
  schedule: '0 */1 * * * *',
  handler: async (_timer, context) => runDynamicWorkerTick({
    name: 'processarFilaReembolsosGateway',
    importer: () => import('../../workers/reembolsosGatewayWorker.js'),
  }, context),
});