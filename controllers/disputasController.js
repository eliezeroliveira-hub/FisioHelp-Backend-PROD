//  controllers/disputasController.js
import disputasService from '../services/disputasService.js';

function handleError(res, erro) {
  const rawMsg = String(erro?.message || '');
  let status = erro?.statusCode || erro?.codigo || 500;
  let msg = rawMsg || 'Erro interno.';

  //  Mensagem orientada para "Suporte > Novo chamado > Contestações" fora do caso "Paciente Ausente"
  if (
    rawMsg.includes('Consulta não está marcada como "Paciente Ausente"') ||
    rawMsg.includes('Consulta não está marcada como \"Paciente Ausente\"')
  ) {
    status = 400;
    msg =
      'Esta contestação por aqui só pode ser aberta quando a consulta está marcada como "No-Show" (Paciente Ausente). ' +
      'Se a consulta já foi concluída/confirmada e você ainda quer contestar, use o "Suporte" > "Novo chamado" > "Contestações" (prazo de até 30 dias).';
  }

  return res.status(status).json({
    sucesso: false,
    erro: status >= 500 ? 'Erro interno do servidor.' : msg,
    detalhes: erro?.details ?? erro?.detalhes ?? undefined
  });
}

function requireUsuario(req, res) {
  const usuario = req.usuario;
  if (!usuario?.id || !usuario?.tipo) {
    res.status(401).json({ sucesso: false, erro: 'Token ausente, inválido ou expirado.' });
    return null;
  }
  return usuario;
}

const disputasController = {
  // GET /api/disputas?status=&consultaId=&fisioterapeutaId=&pacienteId=
  async listar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const filtros = {
        status: req.query.status ?? null,
        consultaId: req.query.consultaId ?? null,
        fisioterapeutaId: req.query.fisioterapeutaId ?? null,
        pacienteId: req.query.pacienteId ?? null
      };

      // Segurança extra: força o próprio ID conforme o tipo
      const tipo = String(usuario.tipo).toLowerCase();

      if (tipo === 'paciente') {
        filtros.pacienteId = usuario.id;
      } else if (tipo === 'fisioterapeuta') {
        filtros.fisioterapeutaId = usuario.id;
      }

      let dados = await disputasService.listarDisputas(usuario, filtros);

      // Mensagem para o fisio quando a disputa for procedente ao paciente (abatimento / clawback)
      if (tipo === 'fisioterapeuta') {
        dados = (dados || []).map((d) => {
          const st = String(d?.StatusDisputa ?? '').trim();
          if (st === 'ProcedentePaciente') {
            return {
              ...d,
              MensagemFisioterapeuta:
                'Disputa procedente ao paciente: O valor será abatido automaticamente do seu próximo repasse (estorno ao paciente).'
            };
          }
          return d;
        });
      }

      return res.json({ sucesso: true, disputas: dados });

    }
      catch (erro) {
      return handleError(res, erro);
    }
  },

  // GET /api/disputas/consultas/:consultaId/evidencias
  async evidenciasConsulta(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const consultaId = Number(req.params.consultaId);
      const dados = await disputasService.obterEvidenciasConsulta(usuario, consultaId);
      return res.json({  sucesso: true, consultaId: dados.consultaId, consulta: dados.consulta, logs: dados.logs});
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  // POST /api/disputas/abrir  { "ConsultaId": 123, "Motivo": "..." }
  async abrir(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const consultaId = Number(req.body?.ConsultaId);
const motivo = req.body?.Motivo ?? null;

// Normaliza opção (aceita: "Crédito", "credito", "REEMBOLSO", etc.)
const normalizarOpcaoReembolso = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const semAcento = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const up = semAcento.toUpperCase();
  if (up === 'CREDITO') return 'Credito';
  if (up === 'REEMBOLSO') return 'Reembolso';
  return null;
};

const opcaoReembolso = normalizarOpcaoReembolso(req.body?.OpcaoReembolso);

// Paciente: exige opcaoReembolso no body
if (String(usuario?.tipo || '').toLowerCase() === 'paciente' && !opcaoReembolso) {
  const e = new Error('OpcaoReembolso é obrigatória (use "Credito" ou "Reembolso").');
  e.statusCode = 400;
  throw e;
}

const dados = await disputasService.abrirDisputa(
  usuario,
  consultaId,
  usuario.id,
  motivo,
  opcaoReembolso
);
return res.status(201).json({ sucesso: true, disputa: dados });

    } catch (erro) {
      return handleError(res, erro);
    }
  },

  // PATCH /api/disputas/:disputaId/em-analise
  async marcarEmAnalise(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const disputaId = Number(req.params.disputaId);
      const dados = await disputasService.marcarEmAnalise(usuario, disputaId);
      return res.json({ sucesso: true, disputa: dados });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  // POST /api/disputas/:disputaId/resolver  { "NovoStatus": "...", "Resolucao": "...", "ValorReembolso": 0 }
  async resolver(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const payload = {
        disputaId: Number(req.params.disputaId),
        novoStatus: req.body?.NovoStatus,
        resolucao: req.body?.Resolucao ?? null,
        valorReembolso: req.body?.ValorReembolso ?? null,
        usuarioId: usuario.id,
        usuarioTipo: usuario.tipo
      };

      const dados = await disputasService.resolverDisputa(usuario, payload);
      return res.json({ sucesso: true, disputa: dados });
    } catch (erro) {
      return handleError(res, erro);
    }
  }
};

export default disputasController;

