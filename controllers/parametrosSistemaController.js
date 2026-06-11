import { sql } from '../config/dbConfig.js';
import { queryWithContext } from '../services/_queryWithContext.js';

const PARAM_NOME = 'ValorMinimoConsulta';
const BANCOS_CACHE_MS = 12 * 60 * 60 * 1000;
let bancosCache = {
  data: null,
  expiresAt: 0,
};

async function carregarBancosBrasilApi() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch('https://brasilapi.com.br/api/banks/v1', {
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`BrasilAPI retornou HTTP ${resp.status}.`);
    }

    const todos = await resp.json();
    if (!Array.isArray(todos)) {
      throw new Error('Resposta inválida ao carregar bancos.');
    }

    const bancosNormalizados = todos
      .filter((banco) => {
        const code = banco?.code;
        if (code === null || code === undefined || String(code).trim() === '') return false;
        const numericCode = Number(code);
        return Number.isInteger(numericCode) && numericCode > 0;
      })
      .map((banco) => ({
        codigo: String(Number(banco.code)).padStart(3, '0'),
        nome: String(banco.fullName || banco.name || '').trim(),
      }))
      .filter((banco) => banco.nome);

    const unicosPorCodigo = new Map();
    for (const banco of bancosNormalizados) {
      if (!unicosPorCodigo.has(banco.codigo)) {
        unicosPorCodigo.set(banco.codigo, banco);
      }
    }

    return [...unicosPorCodigo.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  } finally {
    clearTimeout(timeout);
  }
}

const parametrosSistemaController = {
  async obterParametros(_req, res) {
    try {
      const result = await queryWithContext(
        null,
        null,
        `
          SELECT
            Id,
            Nome,
            ValorDecimal,
            ValorTexto,
            Ativo,
            DataAtualizacao
          FROM dbo.ParametrosSistema
          WHERE Ativo = 1
          ORDER BY Nome ASC;
        `
      );

      return res.json({ sucesso: true, parametros: result.recordset || [] });
    } catch (_erro) {
      return res.status(500).json({ sucesso: false, erro: 'Erro interno do servidor.' });
    }
  },

  async obterValorMinimoConsulta(_req, res) {
    try {
      const result = await queryWithContext(
        null,
        (request) => request.input('Nome', sql.NVarChar(200), PARAM_NOME),
        `
          SELECT TOP 1
            ValorDecimal,
            DataAtualizacao
          FROM dbo.ParametrosSistema
          WHERE Nome = @Nome AND Ativo = 1;
        `
      );

      const row = result.recordset?.[0];
      const valor = Number(row?.ValorDecimal);

      if (!Number.isFinite(valor) || valor <= 0) {
        return res.status(404).json({ sucesso: false, erro: 'Parâmetro não configurado.' });
      }

      return res.json({
        sucesso: true,
        nome: PARAM_NOME,
        valor,
        dataAtualizacao: row?.DataAtualizacao || null,
      });
    } catch (_erro) {
      return res.status(500).json({ sucesso: false, erro: 'Erro interno do servidor.' });
    }
  },

  async obterTaxaIntermediacao(_req, res) {
    try {
      const result = await queryWithContext(
        null,
        null,
        `
          SELECT TOP 1 Percentual
          FROM dbo.Taxas
          WHERE Tipo = 'Intermediacao' AND Ativa = 1
          ORDER BY DataInicio DESC;
        `
      );

      const percentual = Number(result.recordset?.[0]?.Percentual);
      if (!Number.isFinite(percentual) || percentual < 0) {
        return res.status(404).json({ sucesso: false, erro: 'Taxa de intermediação não configurada.' });
      }

      return res.json({ sucesso: true, percentual });
    } catch (_erro) {
      return res.status(500).json({ sucesso: false, erro: 'Erro interno do servidor.' });
    }
  },

  async obterBancos(_req, res) {
    try {
      const agora = Date.now();
      if (Array.isArray(bancosCache.data) && bancosCache.expiresAt > agora) {
        return res.json(bancosCache.data);
      }

      const bancos = await carregarBancosBrasilApi();
      bancosCache = {
        data: bancos,
        expiresAt: agora + BANCOS_CACHE_MS,
      };

      return res.json(bancos);
    } catch (_erro) {
      return res.status(502).json({ sucesso: false, erro: 'Não foi possível carregar a lista de bancos no momento.' });
    }
  },
};

export default parametrosSistemaController;
