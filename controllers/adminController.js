// controllers/adminController.js
import path from 'path';
import adminService from '../services/adminService.js';
import adminAnalyticsService from '../services/adminAnalyticsService.js';
import disputasService from '../services/disputasService.js';
import { log } from '../config/logger.js';

function buildAuditMeta(req) {
  const ip = req?.ip || req?.socket?.remoteAddress || null;
  const userAgent = req?.headers?.['user-agent'] || null;
  return { ip, userAgent };
}

const adminController = {

  // ------------------------------------------------------------------------------------
  //  DASHBOARD / FINANCEIRO BÁSICO
  // ------------------------------------------------------------------------------------
  async dashboardFinanceiro(req, res) {
    try {
      const usuario = req.usuario; // { id, tipo } vindo do JWT
      const resultado = await adminService.dashboardFinanceiro(usuario);
      log('info', 'Dashboard financeiro consultado');
      return res.json(resultado);
    } catch (erro) {
      log('error', 'Erro no dashboard financeiro', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  // ------------------------------------------------------------------------------------
  //  DOCUMENTOS DOS FISIOTERAPEUTAS
  // ------------------------------------------------------------------------------------
  async documentosPendentes(req, res) {
    try {
      const usuario = req.usuario;
      const { limit, offset, status, busca } = req.query;
      const dados = await adminService.documentosPendentes(usuario, { limit, offset, status, busca });
      log('info', `Documentos consultados (${dados.itens.length}/${dados.total})`);
      return res.json(dados);
    } catch (erro) {
      log('error', 'Erro ao consultar documentos pendentes', { erro: erro.message });
      return res.status(erro.statusCode || 500).json({ erro: (erro.statusCode || 500) >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  async validarDocumento(req, res) {
    try {
      const usuario = req.usuario;
      const { documentoId } = req.params;
      const { status, motivoRejeicao } = req.body;
      const adminId = req.usuario.id;

      const resultado = await adminService.validarDocumento(
        usuario,
        documentoId,
        status,
        motivoRejeicao,
        adminId
      );

      log('info', `Documento ${documentoId} marcado como ${status}`);
      return res.json({ sucesso: true, mensagem: resultado });

    } catch (erro) {
      log('error', 'Erro ao validar documento', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  async downloadDocumento(req, res) {
  try {
    const usuario = req.usuario;
    const { documentoId } = req.params;

    const arquivo = await adminService.downloadDocumento(usuario, documentoId);

    // pega só o nome do arquivo (ex.: "1765477288641-754574072.mp4")
    const nomeArquivo = path.basename(arquivo);

    // força download com esse nome
    return res.download(arquivo, nomeArquivo);
  } catch (erro) {
    log('error', 'Erro ao baixar documento', { erro: erro.message });
    return res.status(500).json({ erro: 'Erro interno do servidor.' });
  }
},


  // ------------------------------------------------------------------------------------
  //  INDICAÇÕES – LISTAGEM GERAL (PAINEL ADMIN)
  // ------------------------------------------------------------------------------------
  async listarIndicacoes(req, res) {
    try {
      const usuario = req.usuario;
      const indicacoes = await adminService.listarIndicacoes(usuario);
      log('info', 'Indicações listadas no painel admin');
      return res.json(indicacoes);
    } catch (erro) {
      log('error', 'Erro ao listar indicações', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  // ------------------------------------------------------------------------------------
  //  BLOQUEIO / ATIVAÇÃO DE FISIOTERAPEUTAS
  // ------------------------------------------------------------------------------------
  async listarAuditoriaAcoesAdmin(req, res) {
    try {
      const usuario = req.usuario;
      const dados = await adminService.listarAuditoriaAcoesAdmin(usuario, {
        adminId: req.query?.adminId,
        entidade: req.query?.entidade,
        entidadeId: req.query?.entidadeId,
        acao: req.query?.acao,
        limit: req.query?.limit,
        offset: req.query?.offset,
      });
      return res.json(dados);
    } catch (erro) {
      log('error', 'Erro ao listar auditoria de ações admin', { erro: erro.message });
      return res.status(erro.statusCode || 500).json({ erro: (erro.statusCode || 500) >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  async listarFisioterapeutas(req, res) {
    try {
      const usuario = req.usuario;
      const { busca, status, limit, offset } = req.query;
      const dados = await adminService.listarFisioterapeutas(usuario, { busca, status, limit, offset });

      log('info', `Fisioterapeutas listados (${dados.itens.length}/${dados.total})`);
      return res.json(dados);

    } catch (erro) {
      log('error', 'Erro ao listar fisioterapeutas', { erro: erro.message });
      return res.status(erro.statusCode || 500).json({ erro: (erro.statusCode || 500) >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  async listarPacientes(req, res) {
    try {
      const usuario = req.usuario;
      const { busca, status, limit, offset } = req.query;
      const dados = await adminService.listarPacientes(usuario, { busca, status, limit, offset });

      log('info', `Pacientes listados (${dados.itens.length}/${dados.total})`);
      return res.json(dados);

    } catch (erro) {
      log('error', 'Erro ao listar pacientes', { erro: erro.message });
      return res.status(erro.statusCode || 500).json({ erro: (erro.statusCode || 500) >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  async bloquearFisioterapeuta(req, res) {
    try {
      const usuario = req.usuario;
      const { id } = req.params;
      const resp = await adminService.bloquearFisioterapeuta(usuario, id, buildAuditMeta(req));

      log('warn', `Fisioterapeuta ${id} foi BLOQUEADO`);
      return res.json({ sucesso: true, mensagem: resp });

    } catch (erro) {
      log('error', 'Erro ao bloquear fisioterapeuta', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  async desbloquearFisioterapeuta(req, res) {
    try {
      const usuario = req.usuario;
      const { id } = req.params;
      const resp = await adminService.desbloquearFisioterapeuta(usuario, id, buildAuditMeta(req));

      log('info', `Fisioterapeuta ${id} foi DESBLOQUEADO`);
      return res.json({ sucesso: true, mensagem: resp });

    } catch (erro) {
      log('error', 'Erro ao desbloquear fisioterapeuta', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  async ativarFisioterapeuta(req, res) {
    try {
      const usuario = req.usuario;
      const { id } = req.params;
      const resp = await adminService.ativarFisioterapeuta(usuario, id, buildAuditMeta(req));

      log('info', `Fisioterapeuta ${id} foi ATIVADO`);
      return res.json({ sucesso: true, mensagem: resp });

    } catch (erro) {
      log('error', 'Erro ao ativar fisioterapeuta', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  async desativarFisioterapeuta(req, res) {
    try {
      const usuario = req.usuario;
      const { id } = req.params;
      const resp = await adminService.desativarFisioterapeuta(usuario, id, buildAuditMeta(req));

      log('warn', `Fisioterapeuta ${id} foi DESATIVADO`);
      return res.json({ sucesso: true, mensagem: resp });

    } catch (erro) {
      log('error', 'Erro ao desativar fisioterapeuta', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  // ------------------------------------------------------------------------------------
  //  BLOQUEIO / DESBLOQUEIO DE PACIENTES
  // ------------------------------------------------------------------------------------
  async bloquearPaciente(req, res) {
    try {
      const usuario = req.usuario;
      const { id } = req.params;
      const resp = await adminService.bloquearPaciente(usuario, id, buildAuditMeta(req));

      log('warn', `Paciente ${id} foi BLOQUEADO`);
      return res.json({ sucesso: true, mensagem: resp });

    } catch (erro) {
      log('error', 'Erro ao bloquear paciente', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  async desbloquearPaciente(req, res) {
    try {
      const usuario = req.usuario;
      const { id } = req.params;
      const resp = await adminService.desbloquearPaciente(usuario, id, buildAuditMeta(req));

      log('info', `Paciente ${id} foi DESBLOQUEADO`);
      return res.json({ sucesso: true, mensagem: resp });

    } catch (erro) {
      log('error', 'Erro ao desbloquear paciente', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  async ativarPaciente(req, res) {
    try {
      const usuario = req.usuario;
      const { id } = req.params;

      const resp = await adminService.ativarPaciente(usuario, id, buildAuditMeta(req));

      log('info', `Paciente ${id} foi ATIVADO`);
      return res.json({ sucesso: true, mensagem: resp });
    } catch (erro) {
      log('error', 'Erro ao ativar paciente', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  async desativarPaciente(req, res) {
    try {
      const usuario = req.usuario;
      const { id } = req.params;

      const resp = await adminService.desativarPaciente(usuario, id, buildAuditMeta(req));

      log('info', `Paciente ${id} foi DESATIVADO`);
      return res.json({ sucesso: true, mensagem: resp });
    } catch (erro) {
      log('error', 'Erro ao desativar paciente', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },


  // ------------------------------------------------------------------------------------
  //  VÍDEO DE APRESENTAÇÃO (ADMIN DEFINE O LINK)
  // ------------------------------------------------------------------------------------
  async atualizarLinkVideoApresentacao(req, res) {
    try {
      const usuario = req.usuario;
      const { id } = req.params; // FisioterapeutaId
      const { linkVideo } = req.body;

      if (!linkVideo) {
        return res.status(400).json({ erro: 'O campo "linkVideo" é obrigatório.' });
      }

      const resp = await adminService.atualizarLinkVideoApresentacao(
        usuario,
        parseInt(id, 10),
        linkVideo
      );

      log(
        'info',
        `Link de vídeo do fisioterapeuta ${id} atualizado pelo admin ${req.usuario?.id}`
      );
      return res.json({
        sucesso: true,
        mensagem: resp,
        linkVideo
      });

    } catch (erro) {
      log('error', 'Erro ao atualizar link de vídeo de apresentação', { erro: erro.message });
      return res.status(erro.statusCode || 500).json({ erro: (erro.statusCode || 500) >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  // ------------------------------------------------------------------------------------
  //  DISPUTAS DE CONSULTAS (PAINEL ADMIN / ANALISTA)
  // ------------------------------------------------------------------------------------

  // Listar disputas (com filtros opcionais)
  async listarDisputas(req, res) {
    try {
      const usuario = req.usuario;
      const filtros = {
        busca: req.query.busca,
        status: req.query.status,
        paginado: true,
        limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset, 10) : undefined,
        consultaId: req.query.consultaId ? parseInt(req.query.consultaId, 10) : undefined,
        fisioterapeutaId: req.query.fisioterapeutaId
          ? parseInt(req.query.fisioterapeutaId, 10)
          : undefined,
        pacienteId: req.query.pacienteId ? parseInt(req.query.pacienteId, 10) : undefined
      };

      const disputas = await disputasService.listarDisputas(usuario, filtros);
      log('info', 'Disputas de consulta listadas no painel admin');
      return res.json(disputas);

    } catch (erro) {
      log('error', 'Erro ao listar disputas', { erro: erro.message });
      return res.status(erro.statusCode || 500).json({ erro: (erro.statusCode || 500) >= 500 ? 'Erro interno do servidor.' : erro.message });
    }
  },

  // Evidências / histórico da consulta (logs)
  async evidenciasConsulta(req, res) {
    try {
      const usuario = req.usuario;
      const { consultaId } = req.params;

      if (!consultaId) {
        return res.status(400).json({ erro: 'ConsultaId é obrigatório.' });
      }

      const evidencias = await disputasService.obterEvidenciasConsulta(
        usuario,
        parseInt(consultaId, 10)
      );

      log('info', `Evidências da consulta ${consultaId} consultadas`);
      return res.json(evidencias);

    } catch (erro) {
      log('error', 'Erro ao consultar evidências da consulta', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  // Marcar disputa como "Em análise"
  async marcarDisputaEmAnalise(req, res) {
    try {
      const usuario = req.usuario;
      const { disputaId } = req.params;
      const { observacoes } = req.body;

      const resp = await disputasService.marcarEmAnalise(
        usuario,
        parseInt(disputaId, 10),
        observacoes
      );

      log('info', `Disputa ${disputaId} marcada como Em análise`);
      return res.json(resp);

    } catch (erro) {
      log('error', 'Erro ao marcar disputa como Em análise', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  // Resolver disputa (ProcedentePaciente / ProcedenteFisio / Cancelada)
  async resolverDisputa(req, res) {
    try {
      const usuario = req.usuario;
      const { disputaId } = req.params;
      const { novoStatus, observacoes } = req.body;

      const adminId = req.usuario?.id || null;

      const resp = await disputasService.resolverDisputa(usuario, {
        disputaId: parseInt(disputaId, 10),
        novoStatus,
        observacoes,
        usuarioId: adminId,
        usuarioTipo: 'Admin'
      });

      log('info', `Disputa ${disputaId} resolvida com status ${novoStatus}`);
      return res.json(resp);

    } catch (erro) {
      log('error', 'Erro ao resolver disputa', { erro: erro.message });
      return res.status(500).json({ erro: 'Erro interno do servidor.' });
    }
  },

  // ====================================================================================
  //  *** NOVAS VIEWS ADMINISTRATIVAS (ANALYTICS) ***
  // ====================================================================================

  // --- Financeiro Geral ---
  async dashboardGerencial(req, res)        { return res.json(await adminAnalyticsService.dashboardGerencial(req.usuario, req.query)); },
  async resumoFinanceiroMensal(req, res)    { return res.json(await adminAnalyticsService.resumoFinanceiroMensal(req.usuario, req.query)); },
  async resumoFinanceiroAnual(req, res)     { return res.json(await adminAnalyticsService.resumoFinanceiroAnual(req.usuario, req.query)); },
  async faturamentoMensal(req, res)         { return res.json(await adminAnalyticsService.faturamentoMensal(req.usuario, req.query)); },
  async faturamentoMensalHistorico(req, res){ return res.json(await adminAnalyticsService.faturamentoMensalHistorico(req.usuario, req.query)); },
  async indicadoresFinanceiros(req, res)    { return res.json(await adminAnalyticsService.indicadoresFinanceiros(req.usuario, req.query)); },
  async pipelineFinanceiro(req, res)        { return res.json(await adminAnalyticsService.pipelineFinanceiro(req.usuario, req.query)); },
  async repassesPendentes(req, res)         { return res.json(await adminAnalyticsService.repassesPendentes(req.usuario, req.query)); },

  // --- Crescimento / Usuários ---
  async crescimentoUsuarios(req, res)       { return res.json(await adminAnalyticsService.crescimentoUsuarios(req.usuario, req.query)); },
  async projecaoMensal(req, res)            { return res.json(await adminAnalyticsService.projecaoMensal(req.usuario, req.query)); },
  async projecaoAnual(req, res)             { return res.json(await adminAnalyticsService.projecaoAnual(req.usuario, req.query)); },
  async retencaoPacientes(req, res)         { return res.json(await adminAnalyticsService.retencaoPacientes(req.usuario, req.query)); },
  async atividadePacientes(req, res)        { return res.json(await adminAnalyticsService.atividadePacientes(req.usuario, req.query)); },

  // --- Fisioterapeutas ---
  async topFisioterapeutas(req, res)        { return res.json(await adminAnalyticsService.topFisioterapeutas(req.usuario, req.query)); },
  async fisioPerformanceMensal(req, res)    { return res.json(await adminAnalyticsService.fisioPerformanceMensal(req.usuario, req.query)); },
  async fisioIndicacoesResumo(req, res)     { return res.json(await adminAnalyticsService.fisioIndicacoes(req.usuario, req.query)); },
  async fisioAssinaturasPremium(req, res)   { return res.json(await adminAnalyticsService.fisioAssinaturasPremium(req.usuario, req.query)); },
  async fisioPontuacaoHistorico(req, res)   { return res.json(await adminAnalyticsService.fisioPontuacaoHistorico(req.usuario, req.query)); },

  // --- Consultas ---
  async consultasPorEspecialidade(req, res) { return res.json(await adminAnalyticsService.consultasPorEspecialidade(req.usuario, req.query)); },
  async consultasStatus(req, res)           { return res.json(await adminAnalyticsService.consultasStatus(req.usuario, req.query)); },
  async especialidadesAtivas(req, res)      { return res.json(await adminAnalyticsService.especialidadesAtivas(req.usuario, req.query)); },
  async funnelConsultas(req, res)           { return res.json(await adminAnalyticsService.funnelConsultas(req.usuario, req.query)); },

  // --- Auditoria / Qualidade ---
  async auditoriaMensagens(req, res)        { return res.json(await adminAnalyticsService.auditoriaMensagens(req.usuario, req.query)); },
  async documentosValidacao(req, res)       { return res.json(await adminAnalyticsService.documentosValidacao(req.usuario, req.query)); },
  async sinaisBypass(req, res)              { return res.json(await adminAnalyticsService.sinaisBypass(req.usuario, req.query)); },
  async fisioAtendimentosPendentes(req, res){ return res.json(await adminAnalyticsService.fisioAtendimentosPendentes(req.usuario, req.query)); },

  // --- Chat ---
  async chatResumo(req, res)                { return res.json(await adminAnalyticsService.chatResumo(req.usuario, req.query)); },
  async chatResumoDiario(req, res)          { return res.json(await adminAnalyticsService.chatResumoDiario(req.usuario, req.query)); },
  async chatStats(req, res)                 { return res.json(await adminAnalyticsService.chatStats(req.usuario, req.query)); },
  async chatAlertas(req, res)               { return res.json(await adminAnalyticsService.chatAlertas(req.usuario, req.query)); },
  async chatReincidentes(req, res)          { return res.json(await adminAnalyticsService.chatReincidentes(req.usuario, req.query)); },

  // --- Monitoramento Dinâmico ---
  async monitor(req, res) {
    return res.json(await adminAnalyticsService.monitor(req.usuario, req.params.view, req.query));
  }

};

export default adminController;


