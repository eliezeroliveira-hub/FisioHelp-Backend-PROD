import { logger } from '../config/logger.js';
import { ENV } from '../config/env.js';

/**
 * 🧱 Middleware global de tratamento de erros
 * Captura qualquer exceção e envia resposta padronizada.
 */
export function errorHandler(err, req, res, next) {
  void next;
  const isUploadValidationError =
    err?.name === 'MulterError' ||
    ['LIMIT_FILE_SIZE', 'LIMIT_UNEXPECTED_FILE', 'TIPO_ARQUIVO_INVALIDO', 'EXTENSAO_INVALIDA'].includes(err?.code);

  const statusRaw = err.status || err.statusCode || err.httpStatus || (isUploadValidationError ? 400 : 500);

  const sqlNumber =
    err?.number ??
    err?.originalError?.info?.number ??
    err?.originalError?.number ??
    null;
  const msg = String(err?.message || '');
  const msgLower = msg.toLowerCase();
  const isSensitiveSqlAuthError =
    sqlNumber === 50090 ||
    (Number.isInteger(sqlNumber) && sqlNumber >= 50000 && /loginlockouts|autentic|auth/i.test(msg)) ||
    /loginlockouts/i.test(msg);
  const isSensitiveSqlObjectError =
    /(?:\bdbo\.)|(?:\bsp_[a-z0-9_]+)|object_id\(/i.test(msg) ||
    (
      /(tabela|view|procedure|stored procedure|função|funcao)/i.test(msg) &&
      /(não encontrada|nao encontrada|not found|missing)/i.test(msg)
    ) ||
    (
      Number.isInteger(sqlNumber) &&
      sqlNumber >= 50000 &&
      /(dbo\.|sp_|object_id\(|tabela|view|procedure|stored procedure|nao encontrada|não encontrada)/i.test(msgLower)
    );

  // 🔍 Contexto opcional de requisição
  const contexto = req?.context || {};
  const rota = req.originalUrl || req.url;
  const metodo = req.method;

  // 🧠 Log detalhado do erro (servidor)
  logger.error('❌ Erro no backend', {
    rota,
    metodo,
    usuario: contexto.userId || 'Desconhecido',
    tipoUsuario: contexto.tipoUsuario || 'Indefinido',
    sqlNumber,
    mensagem: err?.message,
    stack: err?.stack,
  });

  // 📦 Resposta ao cliente (NUNCA envia stack)
  const resposta = {
    erro: 'Erro interno do servidor.',
  };

  const exposeDevMessage =
    ENV.NODE_ENV === 'development' &&
    String(process.env.EXPOSE_DEV_ERROR_MESSAGE || '').trim().toLowerCase() === 'true';

  // Opt-in explícito: evita disclosure por misconfig de NODE_ENV.
  if (exposeDevMessage && !isSensitiveSqlAuthError && !isSensitiveSqlObjectError) {
    resposta.mensagem = err?.message;
  }

  if (isSensitiveSqlAuthError) {
    resposta.erro = 'Erro interno de autenticação. Contate o suporte.';
  } else if (isSensitiveSqlObjectError) {
    resposta.erro = 'Erro interno. Contate o suporte.';
  } else if (err?.code === 'LIMIT_FILE_SIZE') {
    resposta.erro = rota?.includes('/pedidos-medicos/')
      ? 'Arquivo muito grande. Envie um pedido médico de até 20 MB.'
      : 'Arquivo muito grande para upload.';
  } else if (isUploadValidationError && err?.message) {
    resposta.erro = err.message;
  }

  const status = (isSensitiveSqlAuthError || isSensitiveSqlObjectError) ? 500 : statusRaw;
  res.status(status).json(resposta);
}

/**
 * 🧩 Tratadores globais de exceções fora do Express
 * Captura qualquer erro não interceptado.
 */
process.on('uncaughtException', (err) => {
  logger.error('💥 Erro não capturado (uncaughtException)', {
    mensagem: err?.message,
    stack: err?.stack,
  });
  scheduleProcessExit('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('⚠️ Promessa rejeitada sem tratamento (unhandledRejection)', {
    motivo: reason,
    promessa: promise,
  });
  scheduleProcessExit('unhandledRejection');
});

let exitingDueToFatalError = false;
function scheduleProcessExit(origin) {
  if (exitingDueToFatalError) return;
  exitingDueToFatalError = true;

  logger.error('🛑 Encerrando processo por erro fatal', { origem: origin });

  const forceExitTimer = setTimeout(() => {
    process.exit(1);
  }, 2000);
  forceExitTimer.unref();

  // Tenta flush dos transports do Winston antes de encerrar.
  logger.once('finish', () => {
    clearTimeout(forceExitTimer);
    process.exit(1);
  });
  logger.end();
}
