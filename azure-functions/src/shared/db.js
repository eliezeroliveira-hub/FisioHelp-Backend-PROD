import sql from 'mssql';

let poolPromise = null;

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'sim'].includes(String(value).trim().toLowerCase());
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return String(value).trim();
}

export function getSqlConfig() {
  return {
    server: requireEnv('SQL_SERVER'),
    database: requireEnv('SQL_DATABASE'),
    user: requireEnv('SQL_USER'),
    password: requireEnv('SQL_PASSWORD'),
    options: {
      encrypt: boolEnv(process.env.SQL_ENCRYPT, true),
      trustServerCertificate: boolEnv(process.env.SQL_TRUST_SERVER_CERTIFICATE, false),
    },
    pool: {
      max: Number(process.env.SQL_POOL_MAX || 5),
      min: 0,
      idleTimeoutMillis: Number(process.env.SQL_POOL_IDLE_TIMEOUT_MS || 30000),
    },
    requestTimeout: Number(process.env.SQL_REQUEST_TIMEOUT_MS || 60000),
    connectionTimeout: Number(process.env.SQL_CONNECTION_TIMEOUT_MS || 15000),
  };
}

export async function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(getSqlConfig()).catch((error) => {
      poolPromise = null;
      throw error;
    });
  }

  return poolPromise;
}

export { sql };
