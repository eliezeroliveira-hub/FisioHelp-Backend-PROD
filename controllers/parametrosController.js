// 📁 controllers/parametrosController.js
import adminService from '../services/adminService.js';

function getStatusCode(erro) {
  return Number(erro?.statusCode || erro?.httpStatus || erro?.status || 500);
}

function handleControllerError(res, erro, fallbackMessage) {
  const status = getStatusCode(erro);
  return res.status(status).json({
    sucesso: false,
    erro: status >= 500 ? 'Erro interno do servidor.' : (erro?.message || fallbackMessage || 'Erro interno.'),
  });
}

const parametrosController = {

  async listarAssinaturas(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT
      const dados = await adminService.listarAssinaturas(usuario);
      return res.json(dados);
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao listar assinaturas.');
    }
  },

  async atualizarAssinaturas(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT
      await adminService.atualizarAssinaturas(usuario, req.body, usuario?.nome);
      return res.json({ sucesso: true });
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao atualizar assinaturas.');
    }
  },

  async listarSistema(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT
      const dados = await adminService.listarSistema(usuario);
      return res.json(dados);
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao listar parâmetros do sistema.');
    }
  },

  async atualizarSistema(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT
      const body = req.body ?? {};
      const dados = {};

      if (body.ValorMinimoConsulta !== undefined || body.valorMinimoConsulta !== undefined) {
        dados.ValorMinimoConsulta = body.ValorMinimoConsulta ?? body.valorMinimoConsulta;
      }
      if (body.RepasseTarifaPix !== undefined || body.repasseTarifaPix !== undefined) {
        dados.RepasseTarifaPix = body.RepasseTarifaPix ?? body.repasseTarifaPix;
      }
      if (body.RepasseTarifaTed !== undefined || body.repasseTarifaTed !== undefined) {
        dados.RepasseTarifaTed = body.RepasseTarifaTed ?? body.repasseTarifaTed;
      }

      await adminService.atualizarSistema(usuario, dados, usuario?.nome);
      return res.json({ sucesso: true });
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao atualizar parâmetros do sistema.');
    }
  },

  async listarTaxas(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT
      const dados = await adminService.listarTaxas(usuario);
      return res.json(dados);
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao listar taxas.');
    }
  },

  async atualizarTaxaPorId(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT
      await adminService.atualizarTaxaPorId(usuario, req.params.id, req.body.Percentual, usuario?.nome);
      return res.json({ sucesso: true });
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao atualizar taxa.');
    }
  },

  async listarGatewayPerfisCusto(req, res) {
    try {
      const incluirInativos = String(req.query?.incluirInativos ?? req.query?.IncluirInativos ?? 'false').toLowerCase() === 'true';
      const dados = await adminService.listarGatewayPerfisCusto(req.usuario, incluirInativos);
      return res.json({ sucesso: true, itens: dados });
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao listar perfis reais do gateway.');
    }
  },

  async versionarGatewayPerfilCusto(req, res) {
    try {
      const dados = await adminService.versionarGatewayPerfilCusto(req.usuario, req.body);
      return res.json({ sucesso: true, perfil: dados });
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao atualizar perfil real do gateway.');
    }
  },

  async encerrarGatewayPerfilCusto(req, res) {
    try {
      const dados = await adminService.encerrarGatewayPerfilCusto(req.usuario, req.params.id);
      return res.json({ sucesso: true, perfil: dados });
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao encerrar perfil real do gateway.');
    }
  },

  async listarPontuacao(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT
      const dados = await adminService.listarPontuacaoCompleta(usuario);
      return res.json(dados);
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao listar pontuação.');
    }
  },

  async listarPontuacaoRegras(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT
      const dados = await adminService.listarPontuacaoRegras(usuario);
      return res.json(dados);
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao listar regras de pontuação.');
    }
  },

  async listarPontuacaoEventos(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT
      const dados = await adminService.listarPontuacaoEventos(usuario);
      return res.json(dados);
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao listar eventos de pontuação.');
    }
  },

  async atualizarRegra(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT
      await adminService.atualizarPontuacaoRegra(usuario, req.params.id, req.body.Pontos);
      return res.json({ sucesso: true });
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao atualizar regra de pontuação.');
    }
  },

  async atualizarEvento(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT
      await adminService.atualizarPontuacaoEvento(usuario, req.params.id, req.body.Pontos);
      return res.json({ sucesso: true });
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao atualizar evento de pontuação.');
    }
  },

  async listarFinanceiro(req, res) {
    try {
      const dados = await adminService.listarParametrosFinanceiros(
        req.usuario,
        req.query?.Periodo ?? req.query?.periodo,
      );
      return res.json({ sucesso: true, dados });
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao listar parâmetros financeiros.');
    }
  },

  async atualizarFinanceiro(req, res) {
    try {
      await adminService.atualizarParametrosFinanceiros(req.usuario, req.body?.ProLaborePercentual);
      return res.json({ sucesso: true });
    } catch (erro) {
      return handleControllerError(res, erro, 'Erro ao atualizar parâmetros financeiros.');
    }
  },

};

export default parametrosController;
