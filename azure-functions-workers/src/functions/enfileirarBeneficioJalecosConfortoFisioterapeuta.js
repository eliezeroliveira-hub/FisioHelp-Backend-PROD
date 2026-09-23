import { app } from '@azure/functions';
import { runDynamicWorkerTick } from '../shared/runWorkerTick.js';

app.timer('enfileirarBeneficioJalecosConfortoFisioterapeuta', {
  schedule: '0 10 12 * * *',
  runOnStartup: false,
  useMonitor: true,
  handler: async (_timer, context) => runDynamicWorkerTick({
    name: 'enfileirarBeneficioJalecosConfortoFisioterapeuta',
    importer: () => import('../../workers/beneficioJalecosConfortoFisioterapeutaWorker.js'),
  }, context),
});
