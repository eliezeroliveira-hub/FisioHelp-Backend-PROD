// 📁 controllers/creditosController.js
import creditosService from '../services/creditosService.js';
import { log } from '../config/logger.js';

function ensureAuth(req, res) {
  if (!req.usuario?.id || !req.usuario?.tipo) {
    res.status(401).json({ erro: 'Token ausente, inválido ou expirado.' });
    return false;
  }
  return true;
}

function isAdmin(usuario) {
  return String(usuario?.tipo || '').toLowerCase() === 'admin';
}

function isPaciente(usuario) {
  return String(usuario?.tipo || '').toLowerCase() === 'paciente';
}

function handleError(res, erro, msg = 'Erro interno.') {
  const status = Number(erro?.statusCode ?? erro?.httpStatus ?? erro?.status) || 500;
  return res.status(status).json({
    sucesso: false,
    erro: status >= 500 ? 'Erro interno do servidor.' : (erro?.message || msg),
    detalhes: erro?.details ?? erro?.detalhes ?? undefined
  });
}

const creditosController = {
  /**
   * GET /creditos/saldo  (PACIENTE|ADMIN)
   * Retorna apenas: pacienteId + saldoDisponivel
   */
  async saldo(req, res) {
    try {
      if (!ensureAuth(req, res)) return;

      const u = req.usuario;
      if (!isAdmin(u) && !isPaciente(u)) {
        return res.status(403).json({ sucesso: false, erro: 'Acesso negado.' });
      }

      const dados = await creditosService.saldo(u);

      // Compat: "saldoDisponivel" agora representa o saldo LIVRE (PacoteId = NULL)
      const saldoLivre = Number(dados?.saldoLivre ?? dados?.saldoDisponivel ?? 0) || 0;
      const saldoPacotes = Number(dados?.saldoPacotes ?? 0) || 0;

      // Se o service já retornar, usamos; senão calculamos aqui
      const saldoTotalDisponivel =
        Number(dados?.saldoTotalDisponivel ?? dados?.saldoTotal ?? (saldoLivre + saldoPacotes)) || 0;


      return res.json({
        sucesso: true,
        pacienteId: dados?.pacienteId ?? null,
        saldoLivre,
        saldoPacotes,
        saldoTotalDisponivel
      });
    } catch (erro) {
      log('error', 'Erro ao buscar saldo de créditos', { erro: erro?.message });
      return handleError(res, erro, 'Falha ao buscar saldo de créditos.');
    }
  },


  /**
   * GET /creditos?status=Disponivel  (PACIENTE|ADMIN)
   * Sem status, retorna todos os lançamentos visíveis ao usuário.
   */
  async listar(req, res) {
    try {
      if (!ensureAuth(req, res)) return;

      const u = req.usuario;
      if (!isAdmin(u) && !isPaciente(u)) {
        return res.status(403).json({ sucesso: false, erro: 'Acesso negado.' });
      }

      const statusQuery = (req.query?.status ?? '').toString().trim();
      const statusParaConsulta = statusQuery || undefined;
      const pageLimit = Number(req.query?.limit);
      const pageOffset = Number(req.query?.offset);

      const lista = await creditosService.listar(u, {
        status: statusParaConsulta,
        limit: Number.isFinite(pageLimit) ? pageLimit : undefined,
        offset: Number.isFinite(pageOffset) ? pageOffset : undefined
      });

      return res.json({
        sucesso: true,
        total: lista?.total ?? 0,
        limit: lista?.limit ?? 50,
        offset: lista?.offset ?? 0,
        creditos: lista?.itens ?? []
      });
    } catch (erro) {
      log('error', '❌ Erro ao listar créditos', { erro: erro?.message });
      return handleError(res, erro, 'Falha ao listar créditos.');
    }
  }
};

export default creditosController;

