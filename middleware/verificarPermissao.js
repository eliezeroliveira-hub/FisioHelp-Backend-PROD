// 📁 middleware/verificarPermissao.js
import { log } from '../config/logger.js';

/**
 * 🛡️ Middleware de autorização baseado no tipo do usuário.
 */
const verificarPermissao = (tiposPermitidos = []) => {
  return (req, res, next) => {

    const tipoUsuario = req.usuario?.tipo || null;

    if (!tipoUsuario) {
      log('warn', 'Tentativa de acesso sem autenticação.');
      return res.status(401).json({ erro: 'Usuário não autenticado.' });
    }

    if (!tiposPermitidos.includes(tipoUsuario)) {
      log('warn', `🚫 Acesso negado: ${tipoUsuario} tentou acessar rota protegida.`);
      return res.status(403).json({ erro: 'Acesso negado.' });
    }

    return next();
  };
};

export default verificarPermissao;

