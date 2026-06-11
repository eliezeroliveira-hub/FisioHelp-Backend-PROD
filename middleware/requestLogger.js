//middleware/requestLogger.js

import { log } from '../config/logger.js';
import contatoProvider from '../providers/contatoProvider.js';

function mascararIdentificador(raw) {
  const original = String(raw || '').trim();
  if (!original) return 'N/D';

  if (original.includes('@')) {
    return contatoProvider.mascararDestino('Email', original);
  }

  const digits = original.replace(/\D/g, '');
  if (digits.length === 11) {
    return `***.***.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }

  if (digits.length === 14) {
    return `**.***.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
  }

  if (digits.length >= 10 && digits.length <= 13) {
    return contatoProvider.mascararDestino('Telefone', original);
  }

  if (original.length <= 2) return `${original[0] || '*'}*`;
  return `${original.slice(0, 2)}***`;
}

/**
 *  Middleware de auditoria e log de requisições
 * - Agora utiliza corretamente `req.usuario` definido pelo JWT
 */
export const requestLogger = (req, res, next) => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    //  Corrigido: agora utiliza o usuário definido pelo autenticarJWT
    const userId = req.usuario?.id ?? null;
    const tipoUsuario = req.usuario?.tipo ?? 'Anonimo';

    //  Define tag de contexto conforme rota
    let contexto = '[API]';
    if (req.path.includes('/auth/login')) contexto = '[LOGIN]';
    else if (req.path.includes('/auth/oauth')) contexto = '[OAUTH]';
    else if (req.path.includes('/auth/refresh')) contexto = '[REFRESH]';

    //  Contexto adicional apenas para rotas de login / auth
    const extraContext = {};
    if (req.path.startsWith('/auth')) {
      const identificadorRaw =
        req.body?.email ||
        req.body?.cpf ||
        req.body?.cnpj ||
        req.body?.login ||
        'N/D';

      extraContext.identificador =
        mascararIdentificador(identificadorRaw);

      extraContext.tipoUsuario = tipoUsuario;
    }

    //  Estrutura do log
    const logData = {
      metodo: req.method,
      rota: req.originalUrl,
      status: res.statusCode,
      duracaoMs: durationMs.toFixed(2),
      ip: req.ip,
      userId,
      tipoUsuario,
      ...extraContext
    };

    //  Severidade
    if (res.statusCode >= 400) {
      log('warn', `${contexto}  Requisição inválida`, logData);
    } else if (req.path.startsWith('/auth')) {
      log('info', `${contexto}  Requisição autenticada`, logData);
    } else {
      log('info', `${contexto}  Requisição recebida`, logData);
    }
  });

  next();
};
