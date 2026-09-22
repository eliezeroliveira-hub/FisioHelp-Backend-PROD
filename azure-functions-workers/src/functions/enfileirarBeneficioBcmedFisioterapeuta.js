import { app } from '@azure/functions';
import { runDynamicWorkerTick } from '../shared/runWorkerTick.js';

app.timer('enfileirarBeneficioBcmedFisioterapeuta', {
  schedule: '0 0 12 * * *',
  runOnStartup: false,
  useMonitor: true,
  handler: async (_timer, context) => runDynamicWorkerTick({
    name: 'enfileirarBeneficioBcmedFisioterapeuta',
    importer: () => import('../../workers/beneficioBcmedFisioterapeutaWorker.js'),
  }, context),
});
