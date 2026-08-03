import { app } from '@azure/functions';
import { runDynamicWorkerTick } from '../shared/runWorkerTick.js';

app.timer('enfileirarLembretePerfilFisioterapeuta', {
  schedule: '0 */15 * * * *',
  handler: async (_timer, context) => runDynamicWorkerTick({
    name: 'enfileirarLembretePerfilFisioterapeuta',
    importer: () => import('../../workers/perfilFisioterapeutaLembreteWorker.js'),
  }, context),
});