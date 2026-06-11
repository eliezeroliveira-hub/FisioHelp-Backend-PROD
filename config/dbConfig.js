// config/dbConfig.js
import sql from 'mssql';
import { log } from './logger.js';


function parseIntInRange(raw, fallback, { min = 1, max = 500 } = {}) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente ausente: ${name}`);
  return v;
}

const dbConfig = {
  user: requiredEnv('DB_USER'),
  password: requiredEnv('DB_PASS'),
  server: requiredEnv('DB_SERVER'),
  database: requiredEnv('DB_NAME'),
  port: Number.parseInt(process.env.DB_PORT || '1433', 10),
  pool: {
    // Default "médio" para reduzir enfileiramento sem exagerar em conexões.
    // Ajuste por env conforme tier do banco.
    max: parseIntInRange(
      process.env.DB_POOL_MAX,
      String(process.env.NODE_ENV).toLowerCase() === 'production' ? 30 : 20,
      { min: 1, max: 200 }
    ),
    min: parseIntInRange(
      process.env.DB_POOL_MIN,
      String(process.env.NODE_ENV).toLowerCase() === 'production' ? 5 : 0,
      { min: 0, max: 100 }
    ),
    idleTimeoutMillis: parseIntInRange(process.env.DB_POOL_IDLE_MS, 30000, { min: 1000, max: 300000 }),
  },
  options: {
    // Para Azure SQL, encrypt geralmente deve ser true.
    encrypt: String(process.env.DB_ENCRYPT || 'true').toLowerCase() === 'true',
    // Em dev/local com certificado self-signed, pode ser true.
    // Em produção, deve ser false.
    trustServerCertificate: String(
      process.env.DB_TRUST_CERT ??
      (String(process.env.NODE_ENV).toLowerCase() === 'production' ? 'false' : 'true')
    ).toLowerCase() === 'true',
    enableArithAbort: true,
  },
  // timeouts
  connectionTimeout: Number.parseInt(process.env.DB_CONN_TIMEOUT_MS || '15000', 10),
  requestTimeout: Number.parseInt(process.env.DB_REQ_TIMEOUT_MS || '30000', 10),
};

if (dbConfig.pool.min > dbConfig.pool.max) {
  dbConfig.pool.min = dbConfig.pool.max;
}

let poolPromise = null;

async function createPool() {
  const pool = new sql.ConnectionPool(dbConfig);

  // Logs úteis (sem vazar credenciais)
  pool.on('error', (err) => {
    log('error', 'SQL Pool error', { erro: err?.message || err });
    // força recriação na próxima chamada
    poolPromise = null;
  });

  await pool.connect();
  log('info', 'Configuração pool SQL', {
    max: dbConfig.pool.max,
    min: dbConfig.pool.min,
    idleTimeoutMillis: dbConfig.pool.idleTimeoutMillis,
    requestTimeout: dbConfig.requestTimeout,
    connectionTimeout: dbConfig.connectionTimeout
  });
  log('info', 'Conexão com SQL Server estabelecida (dbConfig).');
  return pool;
}

// Export default: getter do pool (singleton)
export default async function getPool() {
  try {
    if (!poolPromise) {
      log('info', 'Criando novo pool de conexão...');
      poolPromise = createPool().catch((err) => {
        log('error', 'Erro ao conectar ao SQL Server', { erro: err?.message || err });
        poolPromise = null; // permite retry
        throw err;
      });
    }

    const pool = await poolPromise;

    // validação mínima do objeto
    if (!pool || typeof pool.request !== 'function') {
      poolPromise = null;
      throw new Error('Pool inválido — função request não disponível.');
    }

    return pool;
  } catch (error) {
    log('error', 'Falha em getPool()', { erro: error?.message || error });
    throw error;
  }
}

export { sql };

