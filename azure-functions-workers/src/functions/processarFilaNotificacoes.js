import { app } from '@azure/functions';
import { runDynamicWorkerTick } from '../shared/runWorkerTick.js';

app.timer('processarFilaNotificacoes', {
  schedule: '0 */1 * * * *',
  handler: async (_timer, context) => runDynamicWorkerTick({
    name: 'processarFilaNotificacoes',
    importer: () => import('../../workers/notificacoesWorker.js'),
  }, context),
});