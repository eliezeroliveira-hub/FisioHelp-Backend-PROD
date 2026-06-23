// ✅ Carrega variáveis de ambiente primeiro
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';

// ⚙️ Configurações globais
import { ENV } from './config/env.js';
import { log } from './config/logger.js';

// 🧩 Middlewares
import { autenticarJWT } from './middleware/authJWT.js';
import verificarPermissao from './middleware/verificarPermissao.js';
// ❌ Não usar aplicarContextoSQL globalmente (pool pode trocar conexão)
// import { aplicarContextoSQL } from './middleware/sqlSessionContext.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/apiLimiter.js';

// 🚏 Rotas
import routes from './routes/index.js';
import authRoutes from './routes/auth.js';
import debugRoutes from './routes/debug.js'; // ✅ Debug SQL/JWT

// 🗄️ Conexão (para rota de teste)
import getPool from './config/dbConfig.js';
import { startReembolsosGatewayWorker } from './workers/reembolsosGatewayWorker.js';
import { startRepassesGatewayWorker } from './workers/repassesGatewayWorker.js';
import { startNotificacoesWorker } from './workers/notificacoesWorker.js';
import { startAvaliacoesPendentesWorker } from './workers/avaliacoesPendentesWorker.js';
import { startConsultasLembretesWorker } from './workers/consultasLembretesWorker.js';
import { isContatoProviderReal } from './providers/contatoProvider.js';
import fileStorageProvider from './providers/fileStorageProvider.js';

// 🔧 Inicialização
const app = express();

function parseAllowedOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildAllowedOrigins() {
  const fromEnv = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
  if (fromEnv.length > 0) return fromEnv;

  if (ENV.NODE_ENV === 'production') {
    return [
      'https://fisiohelp.com.br',
      'https://www.fisiohelp.com.br'
    ];
  }

  return [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:5173'
  ];
}

const allowedOrigins = new Set(buildAllowedOrigins());

function isPrivateIPv4(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;

  const octets = match.slice(1).map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isAllowedDevelopmentOrigin(origin) {
  if (ENV.NODE_ENV === 'production') return false;

  try {
    const url = new URL(origin);
    const devPorts = new Set(['3000', '3001', '5173', '8080']);
    const hostname = url.hostname.toLowerCase();
    const isHttp = url.protocol === 'http:';
    const isLocalHost = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(hostname);

    return isHttp && devPorts.has(url.port) && (isLocalHost || isPrivateIPv4(hostname));
  } catch {
    return false;
  }
}

const corsOptions = {
  origin(origin, callback) {
    // Sem origin: não precisamos emitir headers CORS.
    // Postman/curl/server-to-server continuam funcionando sem CORS.
    if (!origin) return callback(null, false);
    if (allowedOrigins.has(origin)) return callback(null, true);
    if (isAllowedDevelopmentOrigin(origin)) return callback(null, true);
    return callback(new Error('Origem não permitida pelo CORS.'));
  },
  credentials: true
};

// Proxy reverso (Nginx/Ingress/ELB): usado por req.ip e middlewares de rate limit.
// Config via env:
// - TRUST_PROXY=true|false
// - TRUST_PROXY=<número de hops> (ex.: 1)
const trustProxyRaw = process.env.TRUST_PROXY;
if (trustProxyRaw !== undefined) {
  const normalized = String(trustProxyRaw).trim().toLowerCase();
  if (normalized === 'true') app.set('trust proxy', true);
  else if (normalized === 'false') app.set('trust proxy', false);
  else if (/^\d+$/.test(normalized)) app.set('trust proxy', Number(normalized));
}

// 🌍 Configuração
app.use(helmet());
// Arquivos públicos precisam ser embutíveis por site/admin em outra origem.
// O restante da API mantém Cross-Origin-Resource-Policy: same-origin via helmet global.
app.use('/uploads', helmet.crossOriginResourcePolicy({ policy: 'cross-origin' }));
app.use('/api/arquivos/certificados', helmet.crossOriginResourcePolicy({ policy: 'cross-origin' }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' })); // limite de payload JSON (uploads são via multipart)
app.use(compression());

// 📝 Agora sim, logamos com userId e tipo corretos
app.use(requestLogger);

// 📷 Exposição pública APENAS de arquivos já públicos no desenho atual.
// Em Azure Blob, o container fica privado e o backend faz streaming pela mesma URL.
if (!fileStorageProvider.isAzureBlobStorageEnabled) {
  app.use('/uploads/fotos_perfil', express.static(path.resolve('uploads', 'fotos_perfil')));
  app.use('/uploads/checkin', express.static(path.resolve('uploads', 'checkin')));
}
app.get(/^\/uploads\/(fotos_perfil|checkin)\/(.+)$/, async (req, res, next) => {
  try {
    const pasta = req.params[0];
    const arquivo = req.params[1];
    await fileStorageProvider.sendFile(res, `${pasta}/${arquivo}`, {
      disposition: 'inline',
      cacheControl: pasta === 'fotos_perfil' ? 'public, max-age=86400' : 'no-store',
      fileName: path.basename(arquivo),
      rangeHeader: req.headers.range,
    });
  } catch (err) {
    const status = err?.statusCode || err?.httpStatus || 500;
    if (status === 404) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
    return next(err);
  }
});

// 🧪 Debug (verificar sessão SQL + JWT) — apenas fora de produção
if (ENV.NODE_ENV !== 'production') {
  app.use('/debug', debugRoutes);
}

// 🔐 Rotas públicas
app.use('/auth', authRoutes);

// 🧯 Rate limit global leve para toda API (/api/*)
app.use('/api', apiLimiter);

// 🧭 Rotas principais (APIs reais)
app.use('/api', routes);

// 🏠 Healthcheck
app.get('/', (_req, res) => {
  res.send('🚀 API ativa! JWT ok. Session Context aplicado por query (queryWithContext).');
});

// 🧪 Teste de conexão com o banco (somente DEV/QA e Admin)
if (ENV.NODE_ENV !== 'production') {
  app.get('/teste-db', autenticarJWT, verificarPermissao(['Admin']), async (_req, res, next) => {
    try {
      const pool = await getPool();
      const result = await pool.request().query('SELECT GETDATE() AS DataAtual, DB_NAME() AS BancoAtual');
      res.json({
        mensagem: '✅ Banco conectado com sucesso',
        resultado: result.recordset[0]
      });
    } catch (err) {
      next(err);
    }
  });
}

// 🛡️ Tratamento global de erros
app.use(errorHandler);

// 🚀 Inicializa servidor
app.listen(ENV.PORT, () => {
  log('info', `🚀 Servidor rodando na porta ${ENV.PORT} [${ENV.NODE_ENV}]`);
  log('info', `✅ http://localhost:${ENV.PORT}`);
  if (ENV.NODE_ENV === 'production' && !isContatoProviderReal) {
    log('warn', 'Provider de contato está em stub em produção. Códigos de verificação não serão enviados de verdade.');
  }
  startReembolsosGatewayWorker();
  startRepassesGatewayWorker();
  startNotificacoesWorker();
  startAvaliacoesPendentesWorker();
  startConsultasLembretesWorker();
});

