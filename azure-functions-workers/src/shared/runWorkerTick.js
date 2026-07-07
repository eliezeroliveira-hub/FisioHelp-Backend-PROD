export async function runWorkerTick({ name, tick }, context) {
  const started = Date.now();
  context.log(`[workers] ${name}: iniciando.`);

  try {
    await tick();
    const durationMs = Date.now() - started;
    context.log(`[workers] ${name}: concluido em ${durationMs}ms.`);
  } catch (error) {
    const message = error?.message || String(error);
    context.error(`[workers] ${name}: erro.`, message);
    throw error;
  }
}

export async function runDynamicWorkerTick({ name, importer }, context) {
  let module;

  try {
    module = await importer();
  } catch (error) {
    const details = error?.stack || error?.message || String(error);
    context.error(`[workers] ${name}: erro ao carregar worker.`, details);
    throw error;
  }

  const tick = module?.tick;
  if (typeof tick !== 'function') {
    const error = new Error(`Worker ${name} não exporta tick().`);
    context.error(`[workers] ${name}: erro ao carregar worker.`, error.message);
    throw error;
  }

  return runWorkerTick({ name, tick }, context);
}