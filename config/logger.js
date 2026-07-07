import fs from 'fs';
import path from 'path';
import winston from 'winston';
import chalk from 'chalk';
import 'winston-daily-rotate-file';
import { ENV } from './env.js';

const fileTransports = [];
let fileLoggingDisabledReason = null;

try {
  // 📁 Diretório de logs
  const logDir = path.resolve(process.env.LOG_DIR || 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  // 📆 Rotação diária de logs (1 arquivo/dia)
  const dailyRotateTransport = new winston.transports.DailyRotateFile({
    dirname: logDir,
    filename: '%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: false,
    maxSize: '10m',
    maxFiles: '14d',
    level: ENV.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.json()
    )
  });

  // ❗ Canal de logs exclusivo para erros críticos
  const errorFileTransport = new winston.transports.File({
    dirname: logDir,
    filename: 'error.log',
    level: 'error',
    maxsize: 5 * 1024 * 1024, // 5MB
    maxFiles: 5,
    tailable: true,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.json()
    )
  });

  fileTransports.push(dailyRotateTransport, errorFileTransport);
} catch (error) {
  fileLoggingDisabledReason = error?.message || String(error);
}
// 🎨 Formato colorido e contextual para o console
const consoleTransport = new winston.transports.Console({
  level: ENV.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const ts = chalk.gray(`[${timestamp}]`);
      const env = chalk.magenta(`(${ENV.NODE_ENV})`);
      const app = chalk.green(`[${ENV.APP_NAME || 'MVP Backend'}]`);

      const lvl =
        level === 'error'
          ? chalk.red.bold('ERROR')
          : level === 'warn'
          ? chalk.yellow.bold('WARN ')
          : chalk.cyan.bold('INFO ');

      const metaString =
        Object.keys(meta).length > 0 ? `\n${chalk.gray(JSON.stringify(meta, null, 2))}` : '';

      return `${ts} ${app} ${env} ${lvl} ${message}${metaString}`;
    })
  )
});

// 🧠 Criação do logger principal
export const logger = winston.createLogger({
  level: ENV.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.json()
  ),
  transports: [...fileTransports, consoleTransport],
  exitOnError: false
});

if (fileLoggingDisabledReason) {
  logger.warn('Logs em arquivo desativados; usando apenas console.', {
    erro: fileLoggingDisabledReason
  });
}

/**
 * 🔧 Função auxiliar compatível com sua função anterior
 * Exemplo: log('info', 'Servidor iniciado', { porta: 3001 })
 */
export function log(level, message, meta = {}) {
  if (!logger[level]) {
    logger.info(message, meta);
  } else {
    logger[level](message, meta);
  }
}
