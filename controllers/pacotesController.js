//controllers/pacotesController.js

import pacotesService from '../services/pacotesService.js';
import { log } from '../config/logger.js';
import { HttpError } from '../utils/httpError.js';

function getStatusAndMessage(err) {
  const status =
    (Number.isInteger(err?.statusCode) && err.statusCode)
    || (Number.isInteger(err?.httpStatus) && err.httpStatus)
    || (Number.isInteger(err?.status) && err.status)
    || 500;
  const message = status >= 500
    ? 'Erro interno do servidor.'
    : (err?.message || 'Erro interno.');
  return { status, message };
}

function requireUsuario(req) {
  if (!req.usuario?.tipo || req.usuario?.id == null) {
    throw new HttpError(401, 'Não autenticado.');
  }
  return req.usuario;
}

const pacotesController = {
  async resumoPreCompra(req, res) {
    try {
      const usuario = requireUsuario(req);
      const resultado = await pacotesService.resumoPreCompra(req.body, usuario);

      return res.json({
        sucesso: true,
        resumoFinanceiro: resultado?.resumoFinanceiro ?? null,
        precificacao: resultado?.precificacao ?? null,
      });
    } catch (err) {
      log('error', '[pacotesController.resumoPreCompra] Erro:', err);
      const { status, message } = getStatusAndMessage(err);
      return res.status(status).json({ erro: message });
    }
  },

  async comprar(req, res, next) {
    try {
      const usuario = requireUsuario(req);
      const resultado = await pacotesService.comprar(req.body, usuario);
      const { pacote, precificacao, sumarioContrato } = resultado || {};

     const pacoteMin = pacote
        ? {
            Id: pacote.Id ?? null,

            // padroniza igual seu retorno desejado
            pacoteId: pacote.Id ?? null,
            pacienteId: pacote.PacienteId ?? null,
            PacienteNome: pacote.PacienteNome ?? null,

            fisioterapeutaId: pacote.FisioterapeutaId ?? null,
            NomeFisioterapeuta: pacote.NomeFisioterapeuta ?? null,
            EspecialidadeId: pacote.EspecialidadeId ?? null,
            EspecialidadeNome: pacote.EspecialidadeNome ?? null,

            Nome: pacote.Nome ?? pacote.NomePacote ?? null,
            QuantidadeConsultas: pacote.QuantidadeConsultas ?? null,
            ValorUnitarioAvulso: pacote.ValorUnitarioAvulso ?? null,

            // mantém consistência do valor
            ValorTotal: (precificacao?.valorTotal ?? pacote.ValorTotal) ?? null,
          }
        : null;

      const precificacaoMin = precificacao
        ? {
            valorConsultaBase: precificacao.valorConsultaBase ?? null,
            descontoPacotePercentual: precificacao.descontoPacotePercentual ?? null,
            valorUnitario: precificacao.valorUnitario ?? null,
            valorTotal: precificacao.valorTotal ?? null,
            especialidadeId: precificacao.especialidadeId ?? null,
            especialidadeNome: precificacao.especialidadeNome ?? null,
          }
        : null;
      const sumarioContratoMin = sumarioContrato
        ? {
            Id: sumarioContrato.Id,
            Tipo: sumarioContrato.Tipo,
            Versao: sumarioContrato.Versao,
            Titulo: sumarioContrato.Titulo,
            Conteudo: sumarioContrato.Conteudo,
            PublicadoEm: sumarioContrato.PublicadoEm,
            AtualizadoEm: sumarioContrato.AtualizadoEm,
          }
        : null;

      return res.json({
        sucesso: true,
        pacote: pacoteMin,
        precificacao: precificacaoMin,
        sumarioContrato: sumarioContratoMin
      });
    } catch (err) {
      log('error', '[pacotesController.comprar] Erro:', err);
      const { status, message } = getStatusAndMessage(err);
      return res.status(status).json({ erro: message });
    }
  },

  async confirmarPagamento(req, res, next) {
    try {
      const usuario = requireUsuario(req);
      const pacoteId = req.params.id;
      const resultado = await pacotesService.confirmarPagamento(pacoteId, req.body, usuario);
      const { pacote, precificacao } = resultado || {};

      const pacoteMin = pacote
        ? {
            Id: pacote.Id ?? null,
            PacienteId: pacote.PacienteId ?? null,
            PacienteNome: pacote.PacienteNome ?? null,
            FisioterapeutaId: pacote.FisioterapeutaId ?? null,
            NomeFisioterapeuta: pacote.NomeFisioterapeuta ?? null,
            EspecialidadeId: pacote.EspecialidadeId ?? null,
            EspecialidadeNome: pacote.EspecialidadeNome ?? null,
            Nome: pacote.Nome ?? pacote.NomePacote ?? null,
            QuantidadeConsultas: pacote.QuantidadeConsultas ?? null,
            ValorUnitarioAvulso: pacote.ValorUnitarioAvulso ?? null,
            ValorTotal: pacote.ValorTotal ?? null,
          }
        : null;

      const precificacaoMin = precificacao
        ? {
            valorConsultaBase: precificacao.valorConsultaBase,
            descontoPacotePercentual: precificacao.descontoPacotePercentual,
            valorUnitario: precificacao.valorUnitario,
            valorTotal: precificacao.valorTotal,
            especialidadeId: precificacao.especialidadeId ?? null,
            especialidadeNome: precificacao.especialidadeNome ?? null,
          }
        : null;

      return res.json({ sucesso: true, pacote: pacoteMin, precificacao: precificacaoMin });
    } catch (err) {
      log('error', '[pacotesController.confirmarPagamento] Erro:', err);
      const { status, message } = getStatusAndMessage(err);
      return res.status(status).json({ erro: message });
    }
  },

  opcoesCancelamento: async (req, res) => {
    try {
      const usuario = req.usuario;
      const { id } = req.params;

      const { pacote, sumarioContrato, cancelamento, opcoes, bloqueios } =
        await pacotesService.opcoesCancelamento(id, usuario);

      const pacoteOut = pacote ? {
        Id: pacote.Id,
        pacoteId: pacote.Id,

        PacienteId: pacote.PacienteId,
        PacienteNome: pacote.PacienteNome,

        FisioterapeutaId: pacote.FisioterapeutaId,
        NomeFisioterapeuta: pacote.NomeFisioterapeuta,
        EspecialidadeId: pacote.EspecialidadeId ?? null,
        EspecialidadeNome: pacote.EspecialidadeNome ?? null,

        NomePacote: pacote.NomePacote ?? pacote.Nome,

        QuantidadeConsultas: pacote.QuantidadeConsultas,
        ConsultasUtilizadas: pacote.ConsultasUtilizadas,

        Status: pacote.Status,
        ValorPago: pacote.ValorPago,
        PagoEm: pacote.PagoEm,
      } : null;

      const sumarioContratoOut = sumarioContrato ? {
        Id: sumarioContrato.Id,
        Tipo: sumarioContrato.Tipo,
        Versao: sumarioContrato.Versao,
        Titulo: sumarioContrato.Titulo,
        Conteudo: sumarioContrato.Conteudo,
        PublicadoEm: sumarioContrato.PublicadoEm,
        AtualizadoEm: sumarioContrato.AtualizadoEm,
      } : null;


      const cancelamentoOut = cancelamento ? {
        pacoteId: cancelamento.pacoteId,
        pacienteId: cancelamento.pacienteId,
        pacienteNome: cancelamento.pacienteNome,
        fisioterapeutaId: cancelamento.fisioterapeutaId,
        fisioterapeutaNome: cancelamento.fisioterapeutaNome,
        valorSessaoAvulsa: cancelamento.valorSessaoAvulsa,
        valorPago: cancelamento.valorPago,
        valorSessoesPrestadas: cancelamento.valorSessoesPrestadas,
        saldoNominal: cancelamento.saldoNominal,
        multa: cancelamento.multa,
        valorDevolver: cancelamento.valorDevolver,
        diferencaCobrar: cancelamento.diferencaCobrar,
        sessoesPrestadas: cancelamento.sessoesPrestadas,
        sessoesDisponiveis: cancelamento.sessoesDisponiveis,
        consultasEmAndamento: cancelamento.consultasEmAndamento,
        primeiraConsultaEmAndamento: cancelamento.primeiraConsultaEmAndamento,
      } : null;

      return res.json({
        sucesso: true,
        pacote: pacoteOut,
        sumarioContrato: sumarioContratoOut,
        cancelamento: cancelamentoOut,
        opcoes,
        bloqueios,
      });
    } catch (err) {
      const { status, message } = getStatusAndMessage(err);
      return res.status(status).json({
        sucesso: false,
        erro: message || 'Erro ao obter opções de cancelamento do pacote.',
      });
    }
  },

  cancelar: async (req, res) => {
    try {
      const usuario = req.usuario;
      const { id } = req.params;

      const { pacote, sumarioContrato, cancelamento, opcaoReembolso, reembolsoGateway } =
        await pacotesService.cancelar(id, req.body, usuario);

      const pacoteOut = pacote ? {
        Id: pacote.Id,
        pacoteId: pacote.Id,
        PacienteId: pacote.PacienteId,
        PacienteNome: pacote.PacienteNome,
        FisioterapeutaId: pacote.FisioterapeutaId,
        NomeFisioterapeuta: pacote.NomeFisioterapeuta,
        EspecialidadeId: pacote.EspecialidadeId ?? null,
        EspecialidadeNome: pacote.EspecialidadeNome ?? null,
        Nome: pacote.Nome,
        NomePacote: pacote.NomePacote,
        QuantidadeConsultas: pacote.QuantidadeConsultas,
        ConsultasUtilizadas: pacote.ConsultasUtilizadas,
        Status: pacote.Status,
        ValorPago: pacote.ValorPago,
        PagoEm: pacote.PagoEm,
        CanceladoEm: pacote.CanceladoEm,
      } : null;

      const sumarioContratoOut = sumarioContrato ? {
        Id: sumarioContrato.Id,
        Tipo: sumarioContrato.Tipo,
        Versao: sumarioContrato.Versao,
        Titulo: sumarioContrato.Titulo,
        Conteudo: sumarioContrato.Conteudo,
        PublicadoEm: sumarioContrato.PublicadoEm,
        AtualizadoEm: sumarioContrato.AtualizadoEm,
      } : null;

      const cancelamentoOut = cancelamento ? {
        pacoteId: cancelamento.pacoteId,
        pacienteId: cancelamento.pacienteId,
        pacienteNome: cancelamento.pacienteNome,
        fisioterapeutaId: cancelamento.fisioterapeutaId,
        fisioterapeutaNome: cancelamento.fisioterapeutaNome,
        valorSessaoAvulsa: cancelamento.valorSessaoAvulsa,
        valorPago: cancelamento.valorPago,
        valorSessoesPrestadas: cancelamento.valorSessoesPrestadas,
        saldoNominal: cancelamento.saldoNominal,
        multa: cancelamento.multa,
        valorDevolver: cancelamento.valorDevolver,
        diferencaCobrar: cancelamento.diferencaCobrar,
        sessoesPrestadas: cancelamento.sessoesPrestadas,
        sessoesDisponiveis: cancelamento.sessoesDisponiveis,
        consultasEmAndamento: cancelamento.consultasEmAndamento,
        primeiraConsultaEmAndamento: cancelamento.primeiraConsultaEmAndamento,
      } : null;

      return res.json({
        sucesso: true,
        pacote: pacoteOut,
        sumarioContrato: sumarioContratoOut,
        cancelamento: cancelamentoOut,
        opcaoReembolso,
        reembolsoGateway: reembolsoGateway
          ? {
              Id: reembolsoGateway.Id ?? null,
              Status: reembolsoGateway.Status ?? null,
              PacoteId: reembolsoGateway.PacoteId ?? null,
              GatewayPaymentId: reembolsoGateway.GatewayPaymentId ?? null,
              GatewayInstallmentId: reembolsoGateway.GatewayInstallmentId ?? null,
              Valor: reembolsoGateway.Valor ?? null,
            }
          : null,
      });
    } catch (err) {
      const { status, message } = getStatusAndMessage(err);
      return res.status(status).json({
        sucesso: false,
        erro: message || 'Erro ao cancelar pacote.',
      });
    }
  },

  async listarMeus(req, res) {
    try {
      const usuario = requireUsuario(req);
      const tipo = String(usuario.tipo || '').toLowerCase();
      if (tipo !== 'admin' && tipo !== 'paciente') {
        return res.status(403).json({ sucesso: false, erro: 'Acesso negado.' });
      }

      const status = (req.query?.status ?? '').toString().trim() || undefined;
      const pageLimit = Number(req.query?.limit);
      const pageOffset = Number(req.query?.offset);

      const lista = await pacotesService.listar(usuario, {
        status,
        limit: Number.isFinite(pageLimit) ? pageLimit : undefined,
        offset: Number.isFinite(pageOffset) ? pageOffset : undefined,
      });

      return res.json({
        sucesso: true,
        total: lista.total,
        limit: lista.limit,
        offset: lista.offset,
        itens: lista.itens,
      });
    } catch (err) {
      log('error', '[pacotesController.listarMeus] Erro:', err);
      const { status, message } = getStatusAndMessage(err);
      return res.status(status).json({ sucesso: false, erro: message || 'Falha ao listar pacotes.' });
    }
  },

};

export default pacotesController;
