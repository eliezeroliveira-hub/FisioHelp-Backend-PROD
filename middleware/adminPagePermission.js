import adminPermissionsService from '../services/adminPermissionsService.js';

export default function requireAdminPagePermission(permissionKey) {
  return async (req, res, next) => {
    try {
      const permissionKeys = Array.isArray(permissionKey) ? permissionKey : [permissionKey];
      let allowed = false;

      for (const key of permissionKeys) {
        if (await adminPermissionsService.verificarAcesso(req.usuario, key)) {
          allowed = true;
          break;
        }
      }

      if (!allowed) {
        return res.status(403).json({
          sucesso: false,
          erro: 'Acesso negado para esta área do painel administrativo.',
        });
      }

      return next();
    } catch (erro) {
      const status = Number(erro?.httpStatus || erro?.statusCode || 500);
      return res.status(status).json({
        sucesso: false,
        erro: status >= 500 ? 'Erro interno do servidor.' : (erro?.message || 'Acesso negado.'),
      });
    }
  };
}
