import pacienteCadastroContatoService from '../services/pacienteCadastroContatoService.js';

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

const cadastroPacienteContatoController = {
  solicitarEmail(req, res) {
    return executar(res, () => pacienteCadastroContatoService.solicitarEmail(req.body || {}));
  },

  confirmarEmail(req, res) {
    return executar(res, () => pacienteCadastroContatoService.confirmarEmail(req.body || {}));
  },

  solicitarTelefone(req, res) {
    return executar(res, () => pacienteCadastroContatoService.solicitarTelefone(req.body || {}));
  },

  confirmarTelefone(req, res) {
    return executar(res, () => pacienteCadastroContatoService.confirmarTelefone(req.body || {}));
  },

  status(req, res) {
    return executar(res, () => pacienteCadastroContatoService.obterStatus(req.body || {}));
  },
};

export default cadastroPacienteContatoController;
