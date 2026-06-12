// 📁 controllers/consultasController.js
import consultasService from '../services/consultasService.js';
import { HttpError } from '../utils/httpError.js';
import { log } from '../config/logger.js';

function extractSqlBusinessError(erro) {
  const sqlNumber =
    erro?.number ??
    erro?.originalError?.info?.number ??
    erro?.originalError?.number;

  if (typeof sqlNumber !== 'number' || sqlNumber < 50000) {
    return null;
  }

  return {
    status: 400,
    message:
      erro?.originalError?.info?.message ??
      erro?.message ??
      'Operação não permitida.'
  };
}

function handleError(res, erro, fallbackMessage) {
  const explicitStatus =
    (erro instanceof HttpError && erro.statusCode) ||
    erro?.statusCode ||
    erro?.codigo;
  const sqlBusinessError = explicitStatus ? null : extractSqlBusinessError(erro);
  const status = explicitStatus || sqlBusinessError?.status || 500;

  return res.status(status).json({
    sucesso: false,
    erro:
      status >= 500
        ? 'Erro interno do servidor.'
        : (sqlBusinessError?.message || erro?.message || fallbackMessage || 'Erro interno.'),
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

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip;
}

function isTipo(usuario, tipo) {
  return String(usuario?.tipo || '').toLowerCase() === String(tipo).toLowerCase();
}

/**
 * Normaliza query de performance:
 * - aceita "mes=YYYY-MM" (ex.: 2025-10) e converte para { ano: '2025', mes: '10' }
 * - mantém compatibilidade com "ano=2025&mes=10"
 */
function normalizePerformanceQuery(query = {}) {
  let { ano, mes, limit } = query;

  if (typeof mes === 'string') {
    const m = mes.trim();
    const mYm = /^([0-9]{4})-([0-9]{2})$/;
    if (mYm.test(m)) {
      const [, y, mm] = m.match(mYm);
      if (!ano) ano = y;
      mes = String(Number(mm)); // remove zero à esquerda
    }
  }

  return { ano, mes, limit };
}

const consultasController = {
  /**
   * GET /consultas/minhas
   * - Fisio: pendentes/confirmadas
   * - Paciente: suas consultas
   */
  async minhas(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const tipo = (req.query?.tipo || '').toString().toLowerCase();
      const itens = await consultasService.listarMinhas(usuario, { tipo });

      log('info', '📋 Consultas (minhas) listadas', { userId: usuario.id, tipo: usuario.tipo, filtro: (req.query?.tipo || null), total: itens.length });
      return res.json({ sucesso: true, total: itens.length, itens });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /consultas
   * Mantido por compatibilidade:
   * - Admin: lista tudo
   * - Fisio/Paciente: lista /minhas
   */
  async listar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      if (isTipo(usuario, 'Admin')) {
        const itens = await consultasService.listarTodas(usuario);
        return res.json({ sucesso: true, total: itens.length, itens });
      }

      const itens = await consultasService.listarMinhas(usuario, req.query);
      return res.json({ sucesso: true, total: itens.length, itens });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /consultas/resumo
   */
  async resumo(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const fisioId = isTipo(usuario, 'Admin') ? (req.query.fisioId ?? null) : null;
      const resumo = await consultasService.obterResumoPorFisio(usuario, fisioId ? Number(fisioId) : null);

      return res.json({ sucesso: true, resumo });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /consultas/performance
   * Query: ano, mes, limit, (Admin) fisioId
   * Aceita também: mes=YYYY-MM (ex.: 2025-10)
   */
  async performance(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const fisioId = isTipo(usuario, 'Admin') ? (req.query.fisioId ?? null) : null;
      const q = normalizePerformanceQuery(req.query);

      const itens = await consultasService.listarPerformanceMensal(
        usuario,
        fisioId ? Number(fisioId) : null,
        { ano: q.ano, mes: q.mes, limit: q.limit }
      );

      return res.json({ sucesso: true, total: itens.length, itens });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /consultas/:id
   */
  async buscarPorId(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const consulta = await consultasService.buscarPorId(req.params.id, usuario);
      if (!consulta) return res.status(404).json({ sucesso: false, erro: 'Consulta não encontrada.' });

      return res.json({ sucesso: true, consulta });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /consultas/admin/fisio/:id  (ADMIN)
   */
  async listarPorFisioterapeuta(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      if (!isTipo(usuario, 'Admin')) return res.status(403).json({ sucesso: false, erro: 'Acesso negado.' });

      const itens = await consultasService.listarPorFisio(req.params.id, usuario);
      return res.json({ sucesso: true, total: itens.length, itens });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /consultas/admin/paciente/:id (ADMIN)
   */
  async listarPorPaciente(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      if (!isTipo(usuario, 'Admin')) return res.status(403).json({ sucesso: false, erro: 'Acesso negado.' });

      const itens = await consultasService.listarPorPaciente(req.params.id, usuario);
      return res.json({ sucesso: true, total: itens.length, itens });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * POST /consultas
   * Paciente: força PacienteId = usuario.id
   * Admin: pode criar
   */
  async criar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const payload = { ...(req.body || {}) };

      if (payload.pacienteId !== undefined && payload.PacienteId === undefined) payload.PacienteId = payload.pacienteId;
      if (payload.fisioterapeutaId !== undefined && payload.FisioterapeutaId === undefined) payload.FisioterapeutaId = payload.fisioterapeutaId;
      if (payload.dataHora !== undefined && payload.DataHora === undefined) payload.DataHora = payload.dataHora;
      if (payload.observacoes !== undefined && payload.Observacoes === undefined) payload.Observacoes = payload.observacoes;
      if (payload.valorConsulta !== undefined && payload.ValorConsulta === undefined) payload.ValorConsulta = payload.valorConsulta;
      if (payload.duracaoMinutos !== undefined && payload.DuracaoMinutos === undefined) payload.DuracaoMinutos = payload.duracaoMinutos;
      if (payload.especialidadeId !== undefined && payload.EspecialidadeId === undefined) payload.EspecialidadeId = payload.especialidadeId;

      if (isTipo(usuario, 'Paciente')) payload.PacienteId = Number(usuario.id);

      const resultado = await consultasService.criar(payload, usuario);
      return res.status(201).json({ sucesso: true, consulta: resultado.consulta });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * POST /consultas/pre-agendamento/opcoes-pagamento
   * Simula a criação da consulta com rollback para descobrir as opções
   * de pagamento sem reservar o horário.
   */
  async opcoesPagamentoPreAgendamento(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const payload = { ...(req.body || {}) };

      if (payload.pacienteId !== undefined && payload.PacienteId === undefined) payload.PacienteId = payload.pacienteId;
      if (payload.fisioterapeutaId !== undefined && payload.FisioterapeutaId === undefined) payload.FisioterapeutaId = payload.fisioterapeutaId;
      if (payload.dataHora !== undefined && payload.DataHora === undefined) payload.DataHora = payload.dataHora;
      if (payload.observacoes !== undefined && payload.Observacoes === undefined) payload.Observacoes = payload.observacoes;
      if (payload.valorConsulta !== undefined && payload.ValorConsulta === undefined) payload.ValorConsulta = payload.valorConsulta;
      if (payload.duracaoMinutos !== undefined && payload.DuracaoMinutos === undefined) payload.DuracaoMinutos = payload.duracaoMinutos;
      if (payload.especialidadeId !== undefined && payload.EspecialidadeId === undefined) payload.EspecialidadeId = payload.especialidadeId;

      if (isTipo(usuario, 'Paciente')) payload.PacienteId = Number(usuario.id);

      const resultado = await consultasService.opcoesPagamentoPreAgendamento(payload, usuario);
      return res.json({ sucesso: true, opcoes: resultado.opcoes });
    } catch (erro) {
      return handleError(res, erro, 'Falha ao montar o pré-checkout do agendamento.');
    }
  },

  /**
   * POST /consultas/agendar-com-pagamento
   * Cria a consulta e conclui o pagamento em uma única transação.
   */
  async criarEPagar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const payload = { ...(req.body || {}) };

      if (payload.pacienteId !== undefined && payload.PacienteId === undefined) payload.PacienteId = payload.pacienteId;
      if (payload.fisioterapeutaId !== undefined && payload.FisioterapeutaId === undefined) payload.FisioterapeutaId = payload.fisioterapeutaId;
      if (payload.dataHora !== undefined && payload.DataHora === undefined) payload.DataHora = payload.dataHora;
      if (payload.observacoes !== undefined && payload.Observacoes === undefined) payload.Observacoes = payload.observacoes;
      if (payload.valorConsulta !== undefined && payload.ValorConsulta === undefined) payload.ValorConsulta = payload.valorConsulta;
      if (payload.duracaoMinutos !== undefined && payload.DuracaoMinutos === undefined) payload.DuracaoMinutos = payload.duracaoMinutos;
      if (payload.especialidadeId !== undefined && payload.EspecialidadeId === undefined) payload.EspecialidadeId = payload.especialidadeId;
      if (payload.metodo !== undefined && payload.Metodo === undefined) payload.Metodo = payload.metodo;
      if (payload.pacoteId !== undefined && payload.PacoteId === undefined) payload.PacoteId = payload.pacoteId;
      if (payload.aceitouSumarioContrato !== undefined && payload.AceitouSumarioContrato === undefined) {
        payload.AceitouSumarioContrato = payload.aceitouSumarioContrato;
      }
      if (payload.documentoLegalId !== undefined && payload.DocumentoLegalId === undefined) {
        payload.DocumentoLegalId = payload.documentoLegalId;
      }

      if (isTipo(usuario, 'Paciente')) payload.PacienteId = Number(usuario.id);

      payload.IpAceite = getClientIp(req);
      payload.UserAgentAceite = String(req.get('user-agent') || '');
      payload.OrigemAceite = isTipo(usuario, 'Admin')
        ? 'AgendamentoConsultaAdmin'
        : 'AgendamentoConsulta';

      const { consulta, retorno } = await consultasService.criarEPagar(payload, usuario);

      return res.status(201).json({
        sucesso: true,
        consulta,
        ...(retorno ? { resultado: retorno } : {})
      });
    } catch (erro) {
      return handleError(res, erro, 'Falha ao concluir agendamento com pagamento.');
    }
  },

  async atualizar(_req, res) {
    return res.status(405).json({
      sucesso: false,
      erro: 'Operação não permitida. Use endpoints de ação (confirmar/cancelar/observacoes/comparecimento/validar-token).'
    });
  },

  async remover(_req, res) {
    return res.status(405).json({
      sucesso: false,
      erro: 'Operação não permitida. Use /consultas/:id/cancelar.'
    });
  },

  /**
   * POST /consultas/:id/confirmar
   * (service chama SP_ConfirmarConsulta e pode retornar { consulta, retorno })
   */
  async confirmar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const { consulta, retorno } = await consultasService.confirmar(req.params.id, usuario);

      return res.json({
        sucesso: true,
        consulta,
        ...(retorno ? { resultado: retorno } : {})
      });
    } catch (erro) {
      log('error', '❌ Erro ao confirmar consulta', { erro: erro.message });
      return handleError(res, erro, 'Falha ao confirmar consulta.');
    }
  },

  /**
   * POST /consultas/:id/cancelar
   * (service chama SP_Cancelar... e pode retornar { consulta, retorno })
   */
  async cancelar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const { consulta, retorno } = await consultasService.cancelar(req.params.id, req.body, usuario);

      // Resposta enxuta (ex.: para Paciente)
      if (isTipo(usuario, 'Paciente')) {
        const c = consulta || {};
        const r = retorno || {};

        return res.json({
          sucesso: true,
          ...(r.Mensagem ? { mensagem: r.Mensagem } : {}),
          consulta: {
            Id: c.Id,
            PacienteId: c.PacienteId,
            FisioterapeutaId: c.FisioterapeutaId,
            NomeFisioterapeuta: c.NomeFisioterapeuta ?? null,
            PacienteNome: c.PacienteNome ?? null,
            DataHora: c.DataHora,
            Status: c.Status,
            Observacoes: c.Observacoes ?? null,
            ValorConsulta: c.ValorConsulta,
            DataEncerramento: c.DataEncerramento ?? null,
            MotivoEncerramento: c.MotivoEncerramento ?? null,

            // flags do "resultado" (SP)
            DentroDoPrazo: r.DentroDoPrazo ?? null,
            EstornouCreditoPacote: r.EstornouCreditoPacote ?? false,
            CreditoExisteNaoPacote: r.CreditoExisteNaoPacote ?? false,
            GerouCreditoNaoPacote: r.GerouCreditoNaoPacote ?? false,

            // novo (pago fora da plataforma)
            PagamentoViaPlataforma: r.PagamentoViaPlataforma ?? null,
            SemReembolso: r.SemReembolso ?? false
          }
        });
      }

      // Fisioterapeuta: retorno enxuto (sem "resultado")
        if (isTipo(usuario, 'Fisioterapeuta')) {
          const c = consulta || {};

          return res.json({
            sucesso: true,
            consulta: {
              Id: c.Id,
              PacienteId: c.PacienteId,
              FisioterapeutaId: c.FisioterapeutaId,
              NomeFisioterapeuta: c.NomeFisioterapeuta ?? usuario?.nome ?? usuario?.Nome ?? null,
              PacienteNome: c.PacienteNome ?? null,
              DataHora: c.DataHora,
              Status: c.Status,
              Observacoes: c.Observacoes ?? null,
              DataEncerramento: c.DataEncerramento ?? null,
              MotivoEncerramento: c.MotivoEncerramento ?? null
            }
          });
        }

      // Admin (ou outros): mantém como estava (com resultado separado, se existir)
      return res.json({
        sucesso: true,
        consulta,
        ...(retorno ? { resultado: retorno } : {})
      });
    } catch (erro) {
      log('error', 'Erro ao cancelar consulta', { erro: erro.message });
      return handleError(res, erro, 'Falha ao cancelar consulta.');
    }
  },

  /**
   * POST /consultas/:id/observacoes
   */
  async observacoes(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const consulta = await consultasService.definirObservacoes(req.params.id, req.body, usuario);
      return res.json({ sucesso: true, consulta });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * POST /consultas/:id/comparecimento
   * Check-in do fisioterapeuta (lat/long/hora/evidência).
   * Importante: no "token flow" recomendado, este endpoint NÃO valida token e NÃO conclui a consulta.
   */
  async comparecimento(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const retorno = await consultasService.registrarComparecimento(req.params.id, req.body, usuario);

      // registrarComparecimento pode devolver { consulta, tokenExpiraEm }
      const consulta = retorno?.consulta ?? retorno;
      const tokenExpiraEm = retorno?.tokenExpiraEm ?? null;

      return res.json({
        sucesso: true,
        consulta,
        ...(tokenExpiraEm ? { tokenExpiraEm } : {})
      });
    } catch (erro) {
      return handleError(res, erro);
    }
  },

  /**
   * GET /consultas/:id/termo-consentimento/pdf
   */
  async gerarTermoConsentimento(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const { buffer, filename } = await consultasService.gerarTermoConsentimentoPdf(req.params.id, usuario);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.status(200).send(buffer);
    } catch (erro) {
      return handleError(res, erro, 'Falha ao gerar termo de consentimento.');
    }
  },

  /**
   * Método legado não exposto em rota pública.
   * Chama dbo.SP_GerarTokenValidacaoConsulta
   */
  async gerarTokenValidacao(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;


      // Regra: Paciente nunca gera token. Token é gerado automaticamente no check-in do fisioterapeuta.
      if (String(usuario.tipo || '').toLowerCase() !== 'admin') {
        return res.status(403).json({
          sucesso: false,
          erro: 'Ação não permitida. O token é gerado no check-in pelo fisioterapeuta; o paciente apenas visualiza.'
        });
      }
      const retorno = await consultasService.gerarTokenValidacaoConsulta(req.params.id, usuario);

      return res.json({
        sucesso: true,
        ...(retorno ? retorno : {})
      });
    } catch (erro) {
      log('error', 'Erro ao gerar token de validação', { erro: erro.message });
      return handleError(res, erro, 'Falha ao gerar token.');
    }
  },

  /**
   * POST /consultas/:id/reenviar-token  (PACIENTE | FISIOTERAPEUTA)
   * Regenera o token atual da consulta e reinicia a contagem de tentativas inválidas.
   */
  async reenviarTokenValidacao(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const retorno = await consultasService.reenviarTokenValidacaoConsulta(req.params.id, usuario);

      return res.json({
        sucesso: true,
        ...(retorno ? retorno : {})
      });
    } catch (erro) {
      log('error', 'Erro ao reenviar token de validação', { erro: erro.message });
      return handleError(res, erro, 'Falha ao reenviar token.');
    }
  },

  /**
   * GET /consultas/:id/token  (PACIENTE)
   * Retorna TokenValidacao + TokenGeradoEm + TokenExpiraEm
   */
  async token(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const retorno = await consultasService.obterTokenValidacaoConsulta(req.params.id, usuario);

      return res.json({
        sucesso: true,
        ...(retorno ? retorno : {})
      });
    } catch (erro) {
      log('error', 'Erro ao obter token de validação', { erro: erro.message });
      return handleError(res, erro, 'Falha ao obter token.');
    }
  },

  /**
   * POST /consultas/:id/validar-token  (FISIOTERAPEUTA)
   * Chama dbo.SP_ValidarTokenConsulta e a trigger conclui/encerra automaticamente.
   * Opcionalmente devolve a consulta já atualizada.
   */
  async validarToken(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const retorno = await consultasService.validarTokenConsulta(req.params.id, req.body, usuario);

      return res.json({
        sucesso: true,
        consulta: retorno?.consulta ?? null,
        ...(retorno?.resultado ? { resultado: retorno.resultado } : {})
      });
    } catch (erro) {
      log('error', 'Erro ao validar token', { erro: erro.message });
      return handleError(res, erro, 'Falha ao validar token.');
    }
  },


  /**
   * POST /consultas/:id/pagar-com-creditos  (PACIENTE)
   * (service chama dbo.SP_Pagar_ConsultaComCreditoCarteira)
   */
  async pagarComCreditoCarteira(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      // Defesa extra (a rota já deve estar protegida por verificarPermissao(['Paciente']))
      if (!isTipo(usuario, 'Paciente')) {
        return res.status(403).json({ sucesso: false, erro: 'Apenas Paciente pode pagar com créditos da carteira.' });
      }

      const { consulta, retorno } = await consultasService.pagarComCreditoCarteira(req.params.id, usuario);

      return res.json({
        sucesso: true,
        consulta,
        ...(retorno ? { resultado: retorno } : {})
      });
    } catch (erro) {
      log('error', 'Erro ao pagar consulta com créditos da carteira', { erro: erro.message });
      return handleError(res, erro, 'Falha ao pagar consulta com créditos da carteira.');
    }
  },

  /**
   * POST /consultas/:id/pagar-com-pacote
   * Body opcional: { PacoteId?: number }
   */
  async pagarComPacote(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const { consulta, retorno } = await consultasService.pagarComPacote(
        req.params.id,
        req.body,
        usuario
      );

      return res.json({
        sucesso: true,
        consulta,
        resultado: retorno
      });
    } catch (erro) {
      log('error', 'Erro ao pagar consulta com pacote', { erro: erro?.message });
      return handleError(res, erro, 'Falha ao pagar com pacote.');
    }
  },

  /**
   * POST /consultas/:id/pagar-fora-plataforma  (PACIENTE)
   * Marca a consulta como paga fora da plataforma (apenas quando isento/vínculo ativo).
   */

  async opcoesPagamento(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      const { consulta, opcoes } = await consultasService.opcoesPagamento(req.params.id, usuario);

      // Para Paciente, resposta enxuta: somente "opcoes"
      if (isTipo(usuario, 'Paciente')) {
        return res.json({ sucesso: true, opcoes });
      }

      // Admin/Fisio: pode retornar também os dados da consulta (útil para telas internas)
      return res.json({ sucesso: true, consulta, opcoes });
    } catch (erro) {
      return handleError(res, erro, 'Falha ao consultar opções de pagamento.');
    }
  },

    /**
   * GET /api/consultas/:id/opcoes-no-show-fisio  (PACIENTE)
   */
    async opcoesNoShowFisio(req, res) {
      try {
        const usuario = requireUsuario(req, res);
        if (!usuario) return;
        if (usuario.tipo !== 'Paciente') {
          throw new HttpError(403, 'Somente Paciente pode consultar opções de no-show do fisioterapeuta.');
        }

        const opcoes = await consultasService.opcoesNoShowFisio(req.params.id, usuario);
        return res.json({ sucesso: true, opcoes });
      } catch (erro) {
        return handleError(res, erro, 'Falha ao consultar opções de no-show do fisioterapeuta.');
      }
    },

  /**
   * POST /api/consultas/:id/no-show-fisio/decidir  (PACIENTE)
   * Body: { "Opcao": "Reembolso" | "Credito" | "Reagendar", "Motivo"?: string }
   */
    async decidirNoShowFisio(req, res) {
      try {
        const usuario = requireUsuario(req, res);
        if (!usuario) return;
        if (usuario.tipo !== 'Paciente') {
          throw new HttpError(403, 'Somente Paciente pode decidir no-show do fisioterapeuta.');
        }

        const resultado = await consultasService.decidirNoShowFisio(req.params.id, req.body, usuario);
        return res.json({ sucesso: true, resultado });
      } catch (erro) {
        return handleError(res, erro, 'Falha ao decidir no-show do fisioterapeuta.');
      }
    },

    async reagendar(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;
      if (usuario.tipo !== 'Paciente') {
        throw new HttpError(403, 'Somente Paciente pode reagendar consulta.');
      }

      const { id } = req.params;
      const resultado = await consultasService.reagendar(id, req.body, usuario);

      return res.json({ sucesso: true, resultado });
    } catch (err) {
      log('error', 'Erro ao reagendar consulta', {
        erro: err?.message || err,
        stack: err?.stack
      });
      return handleError(res, err, 'Falha ao reagendar consulta.');
    }

  },

  async cancelarArrependimento7Dias(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;
      if (usuario.tipo !== 'Paciente') {
        throw new HttpError(403, 'Somente Paciente pode cancelar por arrependimento (7 dias).');
      }

      const { id } = req.params;
      const resultado = await consultasService.cancelarArrependimento7Dias(id, req.body, usuario);

      return res.json({ sucesso: true, resultado });
    } catch (err) {
      const sqlNumber = err?.number ?? err?.originalError?.info?.number ?? err?.originalError?.number;
      if (typeof sqlNumber === 'number' && sqlNumber >= 50000) {
        const msg = err?.originalError?.info?.message ?? err?.message ?? 'Operação não permitida.';
        return res.status(400).json({ sucesso: false, erro: msg });
      }

      log('error', 'Erro ao cancelar por arrependimento (7 dias)', {
        erro: err?.message || err,
        stack: err?.stack
      });
      return handleError(res, err, 'Falha ao cancelar por arrependimento (7 dias).');
    }

  },

  async marcarPagaForaPlataforma(req, res) {
    try {
      const usuario = requireUsuario(req, res);
      if (!usuario) return;

      // Defesa extra (a rota já deve estar protegida por verificarPermissao(['Paciente']))
      if (!isTipo(usuario, 'Paciente')) {
        return res.status(403).json({ sucesso: false, erro: 'Apenas Paciente pode marcar pagamento fora da plataforma.' });
      }

      const retorno = await consultasService.marcarPagaForaPlataforma(req.params.id, usuario);

      return res.json({
        sucesso: true,
        ...(retorno ? retorno : {})
      });
    } catch (erro) {
      log('error', 'Erro ao marcar paga fora da plataforma', { erro: erro.message });
      return handleError(res, erro, 'Falha ao marcar pagamento fora da plataforma.');
    }
  }
};

export default consultasController;

