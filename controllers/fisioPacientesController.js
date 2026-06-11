// 📁 controllers/fisioPacientesController.js
import fisioPacientesService from '../services/fisioPacientesService.js';
import { HttpError } from '../utils/httpError.js';

function toBool(value) {
  return value === 1 || value === true || value === '1' || value === 'true';
}

function handleError(res, err) {
  const status = err?.statusCode || (err instanceof HttpError ? err.statusCode : 500);
  return res.status(status).json({
    sucesso: false,
    erro: status >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro interno.'),
    detalhes: status >= 500 ? undefined : (err?.details ?? undefined),
  });
}

const fisioPacientesController = {
  /**
   * GET /fisio/pacientes?q=&limit=&offset=
   */
  async listar(req, res) {
    try {
      const resultado = await fisioPacientesService.listarPacientesAtendidos(req.usuario, req.query);
      const itens = (resultado?.itens ?? []).map((paciente) => ({
        ...paciente,
        CPFValido: toBool(paciente?.CPFValido),
        EmailVerificado: toBool(paciente?.EmailVerificado),
        TelefoneVerificado: toBool(paciente?.TelefoneVerificado),
        ContaVerificada: toBool(paciente?.ContaVerificada),
      }));

      return res.json({
        sucesso: true,
        total: resultado?.total ?? 0,
        limit: resultado?.limit ?? 50,
        offset: resultado?.offset ?? 0,
        itens,
      });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async listarPedidosMedicos(req, res) {
    try {
      const resultado = await fisioPacientesService.listarPedidosMedicosPacientes(req.usuario, req.query);
      return res.json({
        sucesso: true,
        total: resultado?.total ?? 0,
        limit: resultado?.limit ?? 50,
        offset: resultado?.offset ?? 0,
        itens: resultado?.itens ?? [],
      });
    } catch (err) {
      return handleError(res, err);
    }
  },
};

export default fisioPacientesController;

