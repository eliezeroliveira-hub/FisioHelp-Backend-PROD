import { performance } from 'node:perf_hooks';
import { getPool, sql } from './db.js';
import { agoraBrasilDate } from './appDateTime.js';

const ORIGEM_EXECUCAO = 'Azure Function Timer';
const USUARIO_EXECUCAO = 'AzureFunction';

function normalizeError(error) {
  if (!error) return 'Erro desconhecido.';
  return error.message || String(error);
}

async function registrarLog({ jobName, status, mensagem, duracaoSegundos, agoraBrasil }, context) {
  const pool = await getPool();
  await pool.request()
    .input('JobName', sql.NVarChar(200), jobName)
    .input('Status', sql.NVarChar(50), status)
    .input('Mensagem', sql.NVarChar(4000), String(mensagem || '').slice(0, 4000))
    .input('DuracaoSegundos', sql.Int, duracaoSegundos)
    .input('DataExecucao', sql.DateTime2(7), null)
    .input('Usuario', sql.NVarChar(128), USUARIO_EXECUCAO)
    .input('OrigemExecucao', sql.NVarChar(50), ORIGEM_EXECUCAO)
    .input('AgoraBrasil', sql.DateTime2(7), agoraBrasil)
    .execute('dbo.sp_RegistrarLogJob');

  context?.log?.(`[jobs] ${jobName}: log registrado (${status}).`);
}

export async function runSqlJob({ jobName, execute }, context) {
  const started = performance.now();
  const agoraBrasil = agoraBrasilDate();

  context.log(`[jobs] ${jobName}: iniciando.`);

  try {
    const pool = await getPool();
    const result = await execute({ pool, sql, agoraBrasil, context });
    const duracaoSegundos = Math.max(0, Math.round((performance.now() - started) / 1000));

    await registrarLog({
      jobName,
      status: 'OK',
      mensagem: 'Execucao concluida com sucesso.',
      duracaoSegundos,
      agoraBrasil,
    }, context);

    context.log(`[jobs] ${jobName}: concluido em ${duracaoSegundos}s.`);
    return result;
  } catch (error) {
    const duracaoSegundos = Math.max(0, Math.round((performance.now() - started) / 1000));
    const mensagem = normalizeError(error);

    try {
      await registrarLog({
        jobName,
        status: 'ERRO',
        mensagem,
        duracaoSegundos,
        agoraBrasil,
      }, context);
    } catch (logError) {
      context.error(`[jobs] ${jobName}: falha ao registrar log.`, normalizeError(logError));
    }

    context.error(`[jobs] ${jobName}: erro.`, mensagem);
    throw error;
  }
}
