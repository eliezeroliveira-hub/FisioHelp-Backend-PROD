// 📁 controllers/agendaController.js
import agendaService from '../services/agendaService.js';
import { HttpError } from '../utils/httpError.js';

function getSqlMessage(err) {
  return (
    err?.originalError?.info?.message ||
    err?.originalError?.message ||
    err?.message ||
    null
  );
}

function handleError(res, err) {
  const explicitStatus =
    (err instanceof HttpError && err.statusCode) ||
    err?.statusCode ||
    null;
  const sqlNumber =
    err?.number ??
    err?.originalError?.info?.number ??
    err?.originalError?.number ??
    null;
  const sqlMessage = getSqlMessage(err);

  let status = explicitStatus || 500;
  if (!explicitStatus && sqlNumber) {
    if (sqlNumber === 2601 || sqlNumber === 2627 || /conflito/i.test(String(sqlMessage || ''))) {
      status = 409;
    } else if (sqlNumber >= 50000) {
      status = 400;
    }
  }

  return res.status(status).json({
    sucesso: false,
    erro: status >= 500 ? 'Erro interno do servidor.' : (sqlMessage || 'Erro interno.'),
  });
}

function toStartOfDay(dateStr) {
  // "YYYY-MM-DD" => 00:00:00
  return new Date(`${dateStr}T00:00:00`);
}

function toNextDayStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d;
}

function buildRangeFromQuery(query) {
  // prioridade: mes=YYYY-MM
  if (query.mes && /^\d{4}-\d{2}$/.test(query.mes)) {
    const [y, m] = query.mes.split('-').map(Number);
    const de = new Date(y, m - 1, 1, 0, 0, 0, 0);
    const ate = new Date(y, m, 1, 0, 0, 0, 0); // 1º dia do mês seguinte (exclusivo)
    return { de, ate };
  }

  // de/ate (YYYY-MM-DD)
  if (query.de && query.ate && /^\d{4}-\d{2}-\d{2}$/.test(query.de) && /^\d{4}-\d{2}-\d{2}$/.test(query.ate)) {
    const de = toStartOfDay(query.de);
    const ate = toNextDayStart(query.ate); // exclusivo
    return { de, ate };
  }

  // default: mês atual
  const now = new Date();
  const de = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const ate = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return { de, ate };
}

function applyNoStore(res, req) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store',
  });

  if (req?.headers) {
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];
  }
}

const agendaController = {
  async listarMinhaAgenda(req, res) {
    try {
      applyNoStore(res, req);
      const itens = await agendaService.listarMinhaAgenda(req.usuario);
      return res.json({ sucesso: true, total: itens.length, itens });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async criarAgenda(req, res) {
    try {
      const item = await agendaService.criarAgenda(req.usuario, req.body || {});
      return res.status(201).json({ sucesso: true, item });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async atualizarAgenda(req, res) {
    try {
      const item = await agendaService.atualizarAgenda(req.usuario, req.params.id, req.body || {});
      return res.json({ sucesso: true, item });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async excluirAgenda(req, res) {
    try {
      const validarApenas = req.query.validarApenas;
      const result = await agendaService.excluirAgenda(req.usuario, req.params.id, { validarApenas });
      if (String(validarApenas ?? '').trim()) {
        return res.json({ sucesso: true, podeRemover: !!result?.podeRemover, item: result?.item ?? null });
      }
      return res.json({ sucesso: true, removido: result });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async listarMeusBloqueios(req, res) {
    try {
      applyNoStore(res, req);
      const lista = await agendaService.listarMeusBloqueios(req.usuario, {
        de: req.query.de,
        ate: req.query.ate,
        limit: req.query.limit,
        offset: req.query.offset
      });
      return res.json({
        sucesso: true,
        total: lista?.total ?? 0,
        limit: lista?.limit ?? 100,
        offset: lista?.offset ?? 0,
        itens: lista?.itens ?? []
      });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async listarMinhasExcecoes(req, res) {
    try {
      applyNoStore(res, req);
      const itens = await agendaService.listarMinhasExcecoes(req.usuario, {
        de: req.query.de,
        ate: req.query.ate,
      });
      return res.json({ sucesso: true, total: itens.length, itens });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async criarExcecao(req, res) {
    try {
      const item = await agendaService.criarExcecao(req.usuario, req.body || {});
      return res.status(201).json({ sucesso: true, item });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async atualizarExcecao(req, res) {
    try {
      const item = await agendaService.atualizarExcecao(req.usuario, req.params.id, req.body || {});
      return res.json({ sucesso: true, item });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async excluirExcecao(req, res) {
    try {
      const removido = await agendaService.excluirExcecao(req.usuario, req.params.id);
      return res.json({ sucesso: true, removido });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async criarBloqueio(req, res) {
    try {
      const item = await agendaService.criarBloqueio(req.usuario, req.body || {});
      return res.status(201).json({ sucesso: true, item });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async atualizarBloqueio(req, res) {
    try {
      const item = await agendaService.atualizarBloqueio(req.usuario, req.params.id, req.body || {});
      return res.json({ sucesso: true, item });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async excluirBloqueio(req, res) {
    try {
      const validarApenas = req.query.validarApenas;
      const result = await agendaService.excluirBloqueio(req.usuario, req.params.id, { validarApenas });
      if (String(validarApenas ?? '').trim()) {
        return res.json({ sucesso: true, podeRemover: !!result?.podeRemover, item: result?.item ?? null });
      }
      return res.json({ sucesso: true, removido: result });
    } catch (err) {
      return handleError(res, err);
    }
  },

  async obterAgendaPublica(req, res) {
    try {
      applyNoStore(res, req);
      const { de, ate } = buildRangeFromQuery(req.query);
      const data = await agendaService.obterAgendaPublica(req.usuario, req.params.fisioterapeutaId, {
        de: de.toISOString(),
        ate: ate.toISOString(),
      });
      return res.json({
        sucesso: true,
        total: data?.rotina?.length ?? 0,
        itens: data?.rotina ?? [],
        excecoes: data?.excecoes ?? [],
        range: data?.range ?? { de: de.toISOString(), ate: ate.toISOString() },
      });
    } catch (err) {
      return handleError(res, err);
    }
  },

  // calendário do fisioterapeuta
  async obterMeuCalendario(req, res) {
    try {
      applyNoStore(res, req);
      const { de, ate } = buildRangeFromQuery(req.query);

      const data = await agendaService.obterMeuCalendario(req.usuario, {
        de: de.toISOString(),
        ate: ate.toISOString()
      });

      return res.json({ sucesso: true, ...data });
    } catch (err) {
      return handleError(res, err);
    }
  }
};

export default agendaController;
