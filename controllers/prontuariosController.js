// controllers/prontuariosController.js
import prontuariosService from '../services/prontuariosService.js';
import { HttpError } from '../utils/httpError.js';

function handleError(res, err) {
  const status = err?.statusCode || (err instanceof HttpError ? err.statusCode : 500);
  return res.status(status).json({
    sucesso: false,
    erro: status >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro interno.'),
    detalhes: status >= 500 ? undefined : (err?.details ?? undefined),
  });
}

const prontuariosController = {
  /**
   * GET /fisio/pacientes/:id/prontuario
   */
  async obter(req, res) {
    try {
      const prontuario = await prontuariosService.obter(req.usuario, req.params.id);
      return res.json({ sucesso: true, prontuario });
    } catch (err) {
      return handleError(res, err);
    }
  },

  /**
   * POST /fisio/pacientes/:id/prontuario
   */
  async criar(req, res) {
    try {
      const prontuario = await prontuariosService.criar(req.usuario, req.params.id, req.body || {});
      return res.status(201).json({ sucesso: true, prontuario });
    } catch (err) {
      return handleError(res, err);
    }
  },

  /**
   * PATCH /fisio/pacientes/:id/prontuario
   */
  async atualizar(req, res) {
    try {
      const prontuario = await prontuariosService.atualizar(req.usuario, req.params.id, req.body || {});
      return res.json({ sucesso: true, prontuario });
    } catch (err) {
      return handleError(res, err);
    }
  },

  /**
   * POST /fisio/pacientes/:id/prontuario/assinar
   */
  async assinar(req, res) {
    try {
      const xff = req.headers['x-forwarded-for'];
      const ip = xff ? String(xff).split(',')[0].trim() : req.ip;
      const prontuario = await prontuariosService.assinar(req.usuario, req.params.id, { ip });
      return res.json({ sucesso: true, prontuario });
    } catch (err) {
      return handleError(res, err);
    }
  },
  
  /**
   * GET /fisio/pacientes/:id/prontuario/pdf
   */
  async baixarPdf(req, res) {
    try {
      const { buffer, filename } = await prontuariosService.baixarPdf(req.usuario, req.params.id);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.status(200).send(buffer);
    } catch (err) {
      return handleError(res, err);
    }
  },
};

export default prontuariosController;

