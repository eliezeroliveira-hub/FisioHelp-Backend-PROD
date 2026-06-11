// 📁 middleware/exigirAceiteLegais.js
import legaisService from '../services/legaisService.js';
import { log } from '../config/logger.js';
import {
  getLegaisPendenciasCache,
  setLegaisPendenciasCache
} from '../utils/legaisPendenciasCache.js';

/**
 * Bloqueia o uso do app até o usuário aceitar os documentos legais vigentes.
 * - Aplica para: Paciente e Fisioterapeuta
 * - Não bloqueia as rotas /legais (porque no routes/index.js elas vêm ANTES deste middleware)
 */
export default async function exigirAceiteLegais(req, res, next) {
  try {
    const u = req.usuario;

    // ✅ só força para Paciente e Fisioterapeuta (Admin fica livre)
    const tipo = String(u?.tipo || '').toLowerCase();
    if (!u || (tipo !== 'paciente' && tipo !== 'fisioterapeuta')) return next();

    const cached = getLegaisPendenciasCache(u.id);
    if (cached) {
      if (!cached.temPendencia) return next();
      return res.status(428).json({
        sucesso: false,
        codigo: 'PENDENCIA_DOCUMENTO_LEGAL',
        mensagem: 'Você precisa aceitar os documentos legais vigentes para continuar.',
        pendencias: cached.pendencias
      });
    }

    const pendencias = await legaisService.verificarPendencias(u);
    const temPendencia = (pendencias || []).some(p => p?.Pendente == 1 || p?.Pendente === true);
    setLegaisPendenciasCache(u.id, { temPendencia, pendencias });

    if (!temPendencia) return next();

    return res.status(428).json({
      sucesso: false,
      codigo: 'PENDENCIA_DOCUMENTO_LEGAL',
      mensagem: 'Você precisa aceitar os documentos legais vigentes para continuar.',
      pendencias
    });
  } catch (e) {
    log('error', 'exigirAceiteLegais falhou', {
      erro: e?.message || e,
      userId: req?.usuario?.id ?? null
    });
    return res.status(500).json({ sucesso: false, erro: 'Falha ao validar documentos legais.' });
  }
}
