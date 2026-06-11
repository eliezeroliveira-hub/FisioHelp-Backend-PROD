// 📁 controllers/avaliacoesController.js
import avaliacoesService from '../services/avaliacoesService.js';

// Regras novas ficam no service (última consulta concluída + não duplicar).

async function avaliarFisioterapeuta(req, res) {
  try {
    const usuario = req.usuario;
    const { FisioterapeutaId, Nota, Comentario } = req.body || {};

    const result = await avaliacoesService.avaliarFisioterapeuta(
      usuario,
      usuario?.id,
      FisioterapeutaId,
      Nota,
      Comentario
    );

    res.status(201).json({ sucesso: true, item: result });
  } catch (err) {
    res.status(err?.httpStatus || 500).json({ erro: (err?.httpStatus || 500) >= 500 ? 'Erro interno do servidor.' : (err?.message || '') });
  }
}

// NOVO: Fisioterapeuta avalia paciente (última consulta concluída)
async function avaliarPaciente(req, res) {
  try {
    const usuario = req.usuario;
    const { PacienteId, Nota, Comentario } = req.body || {};

    const result = await avaliacoesService.avaliarPaciente(
      usuario,
      usuario?.id,
      PacienteId,
      Nota,
      Comentario
    );

    res.status(201).json({ sucesso: true, item: result });
  } catch (err) {
    res.status(err?.httpStatus || 500).json({ erro: (err?.httpStatus || 500) >= 500 ? 'Erro interno do servidor.' : (err?.message || '') });
  }
}

// Paciente -> lista avaliações RECEBIDAS (fisioterapeuta -> paciente)
async function minhas(req, res) {
  try {
    const usuario = req.usuario;
    const limit = Number(req.query?.limit);
    const offset = Number(req.query?.offset);
    const result = await avaliacoesService.listarMinhasAvaliacoes(usuario, usuario?.id, {
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined
    });
    res.status(200).json({
      sucesso: true,
      total: result?.total ?? 0,
      limit: result?.limit ?? 50,
      offset: result?.offset ?? 0,
      itens: result?.itens ?? []
    });
  } catch (err) {
    res.status(err?.httpStatus || 500).json({ erro: (err?.httpStatus || 500) >= 500 ? 'Erro interno do servidor.' : (err?.message || '') });
  }
}

// Compat: Paciente -> lista avaliações FEITAS (paciente -> fisioterapeuta)
async function feitas(req, res) {
  try {
    const usuario = req.usuario;
    const limit = Number(req.query?.limit);
    const offset = Number(req.query?.offset);
    const result = await avaliacoesService.listarAvaliacoesFeitas(usuario, usuario?.id, {
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined
    });
    res.status(200).json({
      sucesso: true,
      total: result?.total ?? 0,
      limit: result?.limit ?? 50,
      offset: result?.offset ?? 0,
      itens: result?.itens ?? []
    });
  } catch (err) {
    res.status(err?.httpStatus || 500).json({ erro: (err?.httpStatus || 500) >= 500 ? 'Erro interno do servidor.' : (err?.message || '') });
  }
}

export default {
  avaliarFisioterapeuta,
  avaliarPaciente,
  minhas,
  feitas,
};

