import { obterStatusVersaoApp } from '../services/appVersionService.js';
import { ENV } from '../config/env.js';

const appVersionController = {
  status(req, res) {
    try {
      const status = obterStatusVersaoApp({
        plataforma: req.query?.plataforma,
        versao: req.query?.versao,
        build: req.query?.build,
      }, ENV);

      res.set('Cache-Control', 'no-store, max-age=0');
      return res.status(200).json(status);
    } catch (erro) {
      const statusCode = Number(
        erro?.statusCode || erro?.httpStatus || erro?.status || 500
      );
      return res.status(statusCode).json({
        sucesso: false,
        erro:
          statusCode >= 500
            ? 'Não foi possível verificar a versão do aplicativo.'
            : erro?.message || 'Parâmetros inválidos.',
      });
    }
  },
};

export default appVersionController;
