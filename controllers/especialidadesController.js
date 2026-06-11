// 📁 controllers/especialidadesController.js
import { queryWithContext } from '../services/_queryWithContext.js';

const especialidadesController = {
  async listar(req, res) {
    try {
      const usuario = req.usuario || null; // { id, tipo } se estiver autenticado

      const result = await queryWithContext(usuario, null, `
        SELECT Id, Nome, Descricao
        FROM dbo.vw_Especialidades
        ORDER BY Nome ASC;
      `);

      return res.json({
        sucesso: true,
        total: result.recordset.length,
        especialidades: result.recordset
      });

    } catch (erro) {
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  }
};

export default especialidadesController;

