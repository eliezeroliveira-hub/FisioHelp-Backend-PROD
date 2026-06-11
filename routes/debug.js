// 📁 routes/debug.js
import express from 'express';
import getPool from '../config/dbConfig.js';
import { autenticarJWT } from '../middleware/authJWT.js';
import verificarPermissao from '../middleware/verificarPermissao.js';
import { log } from '../config/logger.js';

const router = express.Router();

// 🔒 Protege todas as rotas de debug
router.use(autenticarJWT, verificarPermissao(['Admin']));

router.get('/session', async (req, res) => {
  try {
    const pool = await getPool();

    const result = await pool.request().query(`
      SELECT 
        SESSION_CONTEXT(N'UsuarioId') AS UsuarioId,
        SESSION_CONTEXT(N'UsuarioTipo') AS UsuarioTipo;
    `);

    return res.json({
      contextoSQL: result.recordset[0],
      usuarioJWT: req.usuario || null
    });

  } catch (err) {
    log('error', 'Erro na rota /debug/session', {
      erro: err?.message || err,
      stack: err?.stack
    });
    return res.status(500).json({ erro: err.message });
  }
});

export default router;
