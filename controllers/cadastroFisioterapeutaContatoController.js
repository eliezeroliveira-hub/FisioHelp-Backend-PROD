import fisioterapeutaCadastroContatoService from '../services/fisioterapeutaCadastroContatoService.js';

function responderErro(res, error) {
  const status = Number(error?.statusCode || error?.httpStatus || 500);
  return res.status(status).json({
    sucesso: false,
    erro: status >= 500 ? 'Erro interno do servidor.' : (error?.message || 'Não foi possível processar a validação.'),
  });
}

async function executar(res, callback) {
  try {
    const resultado = await callback();
    return res.json({ sucesso: true, ...resultado });
  } catch (error) {
    return responderErro(res, error);
  }
}

const cadastroFisioterapeutaContatoController = {
  solicitarEmail(req, res) {
    return executar(res, () => fisioterapeutaCadastroContatoService.solicitarEmail(req.body || {}));
  },

  confirmarEmail(req, res) {
    return executar(res, () => fisioterapeutaCadastroContatoService.confirmarEmail(req.body || {}));
  },

  solicitarTelefone(req, res) {
    return executar(res, () => fisioterapeutaCadastroContatoService.solicitarTelefone(req.body || {}));
  },

  confirmarTelefone(req, res) {
    return executar(res, () => fisioterapeutaCadastroContatoService.confirmarTelefone(req.body || {}));
  },

  status(req, res) {
    return executar(res, () => fisioterapeutaCadastroContatoService.obterStatus(req.body || {}));
  },
};

export default cadastroFisioterapeutaContatoController;
