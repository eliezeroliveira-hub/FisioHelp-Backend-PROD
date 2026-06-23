import { sql } from '../config/dbConfig.js';
import { ENV } from '../config/env.js';
import { log } from '../config/logger.js';
import { queryWithContext } from './_queryWithContext.js';
import notificacoesService from './notificacoesService.js';

const REGISTRO = 'Sistema:NotificacoesDispatch';
const CHAT_DEBOUNCE_MINUTOS = 2;

function usuarioSistema() {
  return { tipo: 'Admin', id: Number(ENV.SYSTEM_ADMIN_ID ?? 1) };
}

function asId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function texto(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function limitar(value, max = 500) {
  const normalized = String(value ?? '').trim();
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

function primeiroNome(value, fallback = 'usuário') {
  const normalized = texto(value, fallback);
  return normalized.split(/\s+/)[0] || fallback;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatarDataHora(value) {
  if (!value) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${pad2(value.getUTCDate())}/${pad2(value.getUTCMonth() + 1)}/${value.getUTCFullYear()}, ${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())}`;
  }

  const raw = String(value).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
  if (match) {
    const [, ano, mes, dia, hora, minuto] = match;
    return `${dia}/${mes}/${ano}, ${hora}:${minuto}`;
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return `${pad2(date.getUTCDate())}/${pad2(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}, ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

function trechoMensagem(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'enviou uma mensagem.';

  try {
    const parsed = JSON.parse(raw);
    if (parsed?.tipo === 'documento' || parsed?.tipo === 'documentoPaciente') {
      const textoDoc = String(parsed?.texto ?? '').trim();
      const tipoDoc = String(parsed?.tipoDocumento ?? parsed?.TipoDocumento ?? '').trim();
      if (/autorizacaoatendimento|pedido medico|pedido médico/i.test(`${textoDoc} ${tipoDoc}`)) {
        return 'enviou um pedido médico.';
      }
      return 'enviou um documento.';
    }
  } catch {
    // Mensagem comum, segue abaixo.
  }

  const clean = raw.replace(/\s+/g, ' ');
  return clean.length > 90 ? `${clean.slice(0, 87)}...` : clean;
}

async function safeDispatch(nome, fn) {
  try {
    return await fn();
  } catch (err) {
    log('warn', 'Falha ao enfileirar notificação de domínio', {
      evento: nome,
      erro: err?.message
    });
    return null;
  }
}

async function enfileirar(destinatario, notificacao, { canal = 'push', gravarInbox = true } = {}) {
  const usuarioId = asId(destinatario?.usuarioId);
  const usuarioTipo = texto(destinatario?.usuarioTipo);
  if (!usuarioId || !['Paciente', 'Fisioterapeuta'].includes(usuarioTipo)) return null;

  return notificacoesService.enfileirarNotificacao(
    {
      usuarioTipo,
      usuarioId,
      canal,
      tipo: notificacao.tipo,
      titulo: notificacao.titulo,
      mensagem: limitar(notificacao.mensagem, 500),
      dados: notificacao.dados ?? null,
      referenciaId: notificacao.referenciaId ?? null
    },
    { usuarioRegistro: REGISTRO, gravarInbox }
  );
}

async function enfileirarPushEEmail(destinatario, notificacao, { emailNotificacao = null } = {}) {
  const push = await enfileirar(destinatario, notificacao);
  const email = await enfileirar(destinatario, emailNotificacao ?? notificacao, { canal: 'email', gravarInbox: false });
  return push ?? email;
}

async function buscarConsultaResumo(consultaId) {
  const id = asId(consultaId);
  if (!id) return null;

  const result = await queryWithContext(usuarioSistema(), (req) => {
    req.input('ConsultaId', sql.Int, id);
  }, `
    SELECT TOP (1)
      c.Id,
      c.PacienteId,
      c.FisioterapeutaId,
      c.DataHora,
      c.ValorConsulta,
      LTRIM(RTRIM(ISNULL(c.Status, N''))) AS Status,
      LTRIM(RTRIM(ISNULL(c.StatusPagamento, N''))) AS StatusPagamento,
      p.Nome AS PacienteNome,
      p.EnderecoResidencial AS PacienteEnderecoResidencial,
      p.EnderecoComercial AS PacienteEnderecoComercial,
      p.Cep AS PacienteCep,
      p.CepComercial AS PacienteCepComercial,
      f.Nome AS FisioterapeutaNome,
      f.CREFITO AS FisioterapeutaCrefito,
      f.CNPJ AS FisioterapeutaCnpj,
      ISNULL(e.Nome, f.Especialidade) AS EspecialidadeNome
    FROM dbo.Consultas c
    LEFT JOIN dbo.Pacientes p ON p.Id = c.PacienteId
    LEFT JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
    LEFT JOIN dbo.Especialidades e ON e.Id = c.EspecialidadeId
    WHERE c.Id = @ConsultaId;
  `, { requireContext: true });

  return result.recordset?.[0] ?? null;
}

async function buscarTransacaoConsultaId(transacaoId) {
  const id = asId(transacaoId);
  if (!id) return null;

  const result = await queryWithContext(usuarioSistema(), (req) => {
    req.input('TransacaoId', sql.Int, id);
  }, `
    SELECT TOP (1) ConsultaId
    FROM dbo.Transacoes
    WHERE Id = @TransacaoId;
  `, { requireContext: true });

  return asId(result.recordset?.[0]?.ConsultaId);
}

async function buscarPacoteResumo(pacoteId) {
  const id = asId(pacoteId);
  if (!id) return null;

  const result = await queryWithContext(usuarioSistema(), (req) => {
    req.input('PacoteId', sql.Int, id);
  }, `
    SELECT TOP (1)
      p.Id,
      p.PacienteId,
      p.FisioterapeutaId,
      p.NomePacote,
      p.QuantidadeConsultas,
      p.ValorPago,
      p.ValorTotal,
      p.PagoEm,
      f.Nome AS FisioterapeutaNome,
      ISNULL(e.Nome, f.Especialidade) AS EspecialidadeNome
    FROM dbo.Pacotes p
    LEFT JOIN dbo.Fisioterapeutas f ON f.Id = p.FisioterapeutaId
    LEFT JOIN dbo.Especialidades e ON e.Id = p.EspecialidadeId
    WHERE p.Id = @PacoteId;
  `, { requireContext: true });

  return result.recordset?.[0] ?? null;
}

async function buscarDisputaResumo(disputaId, consultaIdFallback = null) {
  const id = asId(disputaId);
  const consultaFallback = asId(consultaIdFallback);
  if (!id && !consultaFallback) return null;

  const result = await queryWithContext(usuarioSistema(), (req) => {
    req.input('DisputaId', sql.Int, id);
    req.input('ConsultaId', sql.Int, consultaFallback);
  }, `
    SELECT TOP (1)
      d.Id,
      d.ConsultaId,
      d.PacienteId,
      d.Status,
      c.FisioterapeutaId,
      c.DataHora,
      p.Nome AS PacienteNome,
      f.Nome AS FisioterapeutaNome
    FROM dbo.DisputasConsultas d
    INNER JOIN dbo.Consultas c ON c.Id = d.ConsultaId
    LEFT JOIN dbo.Pacientes p ON p.Id = d.PacienteId
    LEFT JOIN dbo.Fisioterapeutas f ON f.Id = c.FisioterapeutaId
    WHERE (@DisputaId IS NOT NULL AND d.Id = @DisputaId)
       OR (@DisputaId IS NULL AND @ConsultaId IS NOT NULL AND d.ConsultaId = @ConsultaId)
    ORDER BY d.Id DESC;
  `, { requireContext: true });

  return result.recordset?.[0] ?? null;
}

async function buscarChamadoResumo(chamadoId) {
  const id = asId(chamadoId);
  if (!id) return null;

  const result = await queryWithContext(usuarioSistema(), (req) => {
    req.input('ChamadoId', sql.Int, id);
  }, `
    SELECT TOP (1)
      Id,
      ProtocoloTexto,
      UsuarioTipo,
      UsuarioId,
      ConsultaId,
      Status
    FROM dbo.FaleConoscoChamados
    WHERE Id = @ChamadoId;
  `, { requireContext: true });

  return result.recordset?.[0] ?? null;
}

async function buscarFisioterapeutaResumo(fisioterapeutaId) {
  const id = asId(fisioterapeutaId);
  if (!id) return null;

  const result = await queryWithContext(usuarioSistema(), (req) => {
    req.input('FisioterapeutaId', sql.Int, id);
  }, `
    SELECT TOP (1)
      Id,
      Nome
    FROM dbo.Fisioterapeutas
    WHERE Id = @FisioterapeutaId;
  `, { requireContext: true });

  return result.recordset?.[0] ?? null;
}

async function jaExisteChatRecente({ usuarioTipo, usuarioId, consultaId }) {
  const destinoId = asId(usuarioId);
  const refId = asId(consultaId);
  if (!destinoId || !refId) return false;

  const result = await queryWithContext(usuarioSistema(), (req) => {
    req.input('UsuarioTipo', sql.NVarChar(20), usuarioTipo);
    req.input('UsuarioId', sql.Int, destinoId);
    req.input('ReferenciaId', sql.Int, refId);
    req.input('JanelaMinutos', sql.Int, CHAT_DEBOUNCE_MINUTOS);
  }, `
    SELECT TOP (1) Id
    FROM dbo.Notificacoes
    WHERE UsuarioTipo = @UsuarioTipo
      AND UsuarioId = @UsuarioId
      AND Tipo = N'Chat'
      AND ReferenciaId = @ReferenciaId
      AND ISNULL(Lida, 0) = 0
      AND DataEnvio >= DATEADD(MINUTE, -@JanelaMinutos, GETDATE())
    ORDER BY Id DESC;
  `, { requireContext: true });

  return !!result.recordset?.[0]?.Id;
}

async function jaExisteEventoPacote({ usuarioId, pacoteId, evento }) {
  const destinoId = asId(usuarioId);
  const refId = asId(pacoteId);
  const tipoEvento = texto(evento);
  if (!destinoId || !refId || !tipoEvento) return false;

  const result = await queryWithContext(usuarioSistema(), (req) => {
    req.input('UsuarioId', sql.Int, destinoId);
    req.input('ReferenciaId', sql.Int, refId);
    req.input('Evento', sql.NVarChar(80), tipoEvento);
  }, `
    SELECT TOP (1) Id
    FROM dbo.FilaNotificacoes
    WHERE UsuarioTipo = N'Paciente'
      AND UsuarioId = @UsuarioId
      AND Canal = N'push'
      AND Tipo = N'Pagamento'
      AND ReferenciaId = @ReferenciaId
      AND JSON_VALUE(DadosJson, '$.tipo') = @Evento
    ORDER BY Id DESC;
  `, { requireContext: true });

  return !!result.recordset?.[0]?.Id;
}

async function jaExisteRepasseConcluido({ fisioterapeutaId, loteId }) {
  const destinoId = asId(fisioterapeutaId);
  const refId = asId(loteId);
  if (!destinoId || !refId) return false;

  const result = await queryWithContext(usuarioSistema(), (req) => {
    req.input('UsuarioId', sql.Int, destinoId);
    req.input('ReferenciaId', sql.Int, refId);
  }, `
    SELECT TOP (1) Id
    FROM dbo.Notificacoes
    WHERE UsuarioTipo = N'Fisioterapeuta'
      AND UsuarioId = @UsuarioId
      AND Tipo = N'Pagamento'
      AND ReferenciaId = @ReferenciaId
    ORDER BY Id DESC;
  `, { requireContext: true });

  return !!result.recordset?.[0]?.Id;
}

async function buscarRepasseConcluidoDestinatarios(loteId) {
  const id = asId(loteId);
  if (!id) return [];

  const result = await queryWithContext(usuarioSistema(), (req) => {
    req.input('LoteId', sql.Int, id);
  }, `
    SELECT
      r.FisioterapeutaId,
      SUM(CAST(ISNULL(i.ValorTransferidoItem, 0) AS DECIMAL(10,2))) AS ValorTransferido
    FROM dbo.LoteRepassesGatewayItens i
    INNER JOIN dbo.Repasses r ON r.Id = i.RepasseId
    WHERE i.LoteId = @LoteId
      AND r.FisioterapeutaId IS NOT NULL
    GROUP BY r.FisioterapeutaId
    ORDER BY r.FisioterapeutaId;
  `, { requireContext: true });

  return result.recordset || [];
}

function formatarMoeda(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  return numero.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function juntarPartes(...partes) {
  return partes
    .map((parte) => texto(parte))
    .filter(Boolean)
    .join(', ');
}

function enderecoAtendimentoConsulta(consulta) {
  const residencial = juntarPartes(consulta?.PacienteEnderecoResidencial, consulta?.PacienteCep);
  if (residencial) return residencial;
  return juntarPartes(consulta?.PacienteEnderecoComercial, consulta?.PacienteCepComercial);
}

function dadosBase(tipo, extras = {}) {
  return { tipo, ...extras };
}

async function consultaAgendada({ consultaId, notificarPaciente = true, notificarFisioterapeuta = true }) {
  return safeDispatch('consultaAgendada', async () => {
    const consulta = await buscarConsultaResumo(consultaId);
    if (!consulta) return null;

    const data = formatarDataHora(consulta.DataHora);
    const payload = dadosBase('consulta_agendada', {
      consultaId: Number(consulta.Id),
      pacienteId: Number(consulta.PacienteId),
      fisioterapeutaId: Number(consulta.FisioterapeutaId)
    });

    const envios = [];
    if (notificarPaciente) {
      envios.push(enfileirarPushEEmail(
        { usuarioTipo: 'Paciente', usuarioId: consulta.PacienteId },
        {
          tipo: 'Agendamento',
          titulo: 'Consulta agendada',
          mensagem: `Sua consulta com ${primeiroNome(consulta.FisioterapeutaNome, 'o fisioterapeuta')}${data ? ` em ${data}` : ''} foi agendada.`,
          referenciaId: Number(consulta.Id),
          dados: payload
        }
      ));
    }

    if (notificarFisioterapeuta) {
      envios.push(enfileirarPushEEmail(
        { usuarioTipo: 'Fisioterapeuta', usuarioId: consulta.FisioterapeutaId },
        {
          tipo: 'Agendamento',
          titulo: 'Nova consulta',
          mensagem: `Nova consulta com ${primeiroNome(consulta.PacienteNome, 'paciente')}${data ? ` em ${data}` : ''}.`,
          referenciaId: Number(consulta.Id),
          dados: payload
        },
        {
          emailNotificacao: {
            tipo: 'Agendamento',
            titulo: 'Nova consulta',
            mensagem: `Olá, ${primeiroNome(consulta.FisioterapeutaNome, 'Fisioterapeuta')},

Você recebeu uma nova consulta com ${primeiroNome(consulta.PacienteNome, 'o paciente')}${data ? ` em ${data}` : ''}.

Para confirmar ou recusar a consulta, abra o app FisioHelp e acesse Consultas.

Atenciosamente,
Equipe FisioHelp`,
            referenciaId: Number(consulta.Id),
            dados: payload
          }
        }
      ));
    }

    const resultados = await Promise.all(envios);
    return resultados.find(Boolean) ?? null;
  });
}

async function consultaConfirmada({ consultaId }) {
  return safeDispatch('consultaConfirmada', async () => {
    const consulta = await buscarConsultaResumo(consultaId);
    if (!consulta) return null;

    const data = formatarDataHora(consulta.DataHora);
    const payload = dadosBase('consulta_confirmada', {
      consultaId: Number(consulta.Id),
      pacienteId: Number(consulta.PacienteId),
      fisioterapeutaId: Number(consulta.FisioterapeutaId)
    });

    await enfileirarPushEEmail(
      { usuarioTipo: 'Paciente', usuarioId: consulta.PacienteId },
      {
        tipo: 'Agendamento',
        titulo: 'Consulta confirmada',
        mensagem: `Sua consulta com ${primeiroNome(consulta.FisioterapeutaNome, 'o fisioterapeuta')}${data ? ` em ${data}` : ''} foi confirmada.`,
        referenciaId: Number(consulta.Id),
        dados: payload
      }
    );

    return enfileirar(
      { usuarioTipo: 'Fisioterapeuta', usuarioId: consulta.FisioterapeutaId },
      {
        tipo: 'Agendamento',
        titulo: 'Consulta confirmada',
        mensagem: `A consulta com ${primeiroNome(consulta.PacienteNome, 'o paciente')}${data ? ` em ${data}` : ''} foi confirmada.`,
        referenciaId: Number(consulta.Id),
        dados: payload
      },
      { canal: 'email', gravarInbox: true }
    );
  });
}

async function consultaReagendada({ consultaId, consultaOriginalId = null, dataHoraAnterior = null }) {
  return safeDispatch('consultaReagendada', async () => {
    const consulta = await buscarConsultaResumo(consultaId);
    if (!consulta) return null;

    const dataNova = formatarDataHora(consulta.DataHora);
    const dataAnterior = formatarDataHora(dataHoraAnterior);
    const trechoData = dataAnterior && dataNova
      ? ` de ${dataAnterior} para ${dataNova}`
      : dataNova
        ? ` para ${dataNova}`
        : '';
    const payload = dadosBase('consulta_reagendada', {
      consultaId: Number(consulta.Id),
      consultaOriginalId: asId(consultaOriginalId) ?? Number(consulta.Id),
      pacienteId: Number(consulta.PacienteId),
      fisioterapeutaId: Number(consulta.FisioterapeutaId),
      dataHoraAnterior: dataHoraAnterior ?? null,
      dataHoraNova: consulta.DataHora ?? null
    });

    await enfileirarPushEEmail(
      { usuarioTipo: 'Paciente', usuarioId: consulta.PacienteId },
      {
        tipo: 'Agendamento',
        titulo: 'Consulta reagendada',
        mensagem: `Sua consulta com ${primeiroNome(consulta.FisioterapeutaNome, 'o fisioterapeuta')} foi reagendada${trechoData}.`,
        referenciaId: Number(consulta.Id),
        dados: payload
      }
    );

    return enfileirarPushEEmail(
      { usuarioTipo: 'Fisioterapeuta', usuarioId: consulta.FisioterapeutaId },
      {
        tipo: 'Agendamento',
        titulo: 'Consulta reagendada',
        mensagem: `A consulta com ${primeiroNome(consulta.PacienteNome, 'o paciente')} foi reagendada${trechoData}.`,
        referenciaId: Number(consulta.Id),
        dados: payload
      }
    );
  });
}

async function tokenConsultaGerado({ consultaId }) {
  return safeDispatch('tokenConsultaGerado', async () => {
    const consulta = await buscarConsultaResumo(consultaId);
    if (!consulta) return null;

    const data = formatarDataHora(consulta.DataHora);
    return enfileirar(
      { usuarioTipo: 'Paciente', usuarioId: consulta.PacienteId },
      {
        tipo: 'Agendamento',
        titulo: 'Código de validação disponível',
        mensagem: `O fisioterapeuta fez check-in${data ? ` na consulta de ${data}` : ''}. Abra a consulta para ver o código de validação.`,
        referenciaId: Number(consulta.Id),
        dados: dadosBase('token_consulta_gerado', {
          consultaId: Number(consulta.Id),
          fisioterapeutaId: Number(consulta.FisioterapeutaId)
        })
      }
    );
  });
}

async function consultaConcluida({ consultaId }) {
  return safeDispatch('consultaConcluida', async () => {
    const consulta = await buscarConsultaResumo(consultaId);
    if (!consulta) return null;

    const payload = dadosBase('consulta_concluida', {
      consultaId: Number(consulta.Id),
      pacienteId: Number(consulta.PacienteId),
      fisioterapeutaId: Number(consulta.FisioterapeutaId)
    });

    await enfileirar(
      { usuarioTipo: 'Paciente', usuarioId: consulta.PacienteId },
      {
        tipo: 'Agendamento',
        titulo: 'Consulta concluída',
        mensagem: `Sua consulta com ${primeiroNome(consulta.FisioterapeutaNome, 'o fisioterapeuta')} foi concluída.`,
        referenciaId: Number(consulta.Id),
        dados: payload
      }
    );

    return enfileirar(
      { usuarioTipo: 'Fisioterapeuta', usuarioId: consulta.FisioterapeutaId },
      {
        tipo: 'Agendamento',
        titulo: 'Consulta concluída',
        mensagem: `A consulta com ${primeiroNome(consulta.PacienteNome, 'o paciente')} foi concluída.`,
        referenciaId: Number(consulta.Id),
        dados: payload
      }
    );
  });
}

async function consultaCancelada({ consultaId, motivo = null, origem = null }) {
  return safeDispatch('consultaCancelada', async () => {
    const consulta = await buscarConsultaResumo(consultaId);
    if (!consulta) return null;

    const data = formatarDataHora(consulta.DataHora);
    const complemento = motivo ? ` Motivo: ${limitar(motivo, 120)}` : '';
    const payload = dadosBase('consulta_cancelada', { consultaId: Number(consulta.Id) });
    const canceladoPeloPaciente = texto(origem).toLowerCase() === 'paciente';
    const emailCancelamentoPaciente = canceladoPeloPaciente
      ? {
          tipo: 'Agendamento',
          titulo: 'Cancelamento da consulta recebido',
          mensagem: `Confirmamos o recebimento da sua solicitação de cancelamento referente à consulta ${Number(consulta.Id)}.`,
          referenciaId: Number(consulta.Id),
          dados: dadosBase('consulta_cancelada', {
            ...payload,
            emailModelo: 'consulta_cancelada_paciente',
            consultaId: Number(consulta.Id),
            dataConsultaTexto: data,
            fisioterapeutaNome: consulta.FisioterapeutaNome ?? null,
            fisioterapeutaCnpj: consulta.FisioterapeutaCnpj ?? null,
          })
        }
      : null;

    await enfileirarPushEEmail(
      { usuarioTipo: 'Paciente', usuarioId: consulta.PacienteId },
      {
        tipo: 'Agendamento',
        titulo: 'Consulta cancelada',
        mensagem: `Sua consulta${data ? ` de ${data}` : ''} foi cancelada.${complemento}`,
        referenciaId: Number(consulta.Id),
        dados: payload
      },
      { emailNotificacao: emailCancelamentoPaciente }
    );

    return enfileirarPushEEmail(
      { usuarioTipo: 'Fisioterapeuta', usuarioId: consulta.FisioterapeutaId },
      {
        tipo: 'Agendamento',
        titulo: 'Consulta cancelada',
        mensagem: `A consulta com ${primeiroNome(consulta.PacienteNome, 'o paciente')}${data ? ` de ${data}` : ''} foi cancelada.${complemento}`,
        referenciaId: Number(consulta.Id),
        dados: payload
      }
    );
  });
}

async function fisioterapeutaAusente({ consultaId }) {
  return safeDispatch('fisioterapeutaAusente', async () => {
    const consulta = await buscarConsultaResumo(consultaId);
    if (!consulta) return null;

    const data = formatarDataHora(consulta.DataHora);
    return enfileirar(
      { usuarioTipo: 'Paciente', usuarioId: consulta.PacienteId },
      {
        tipo: 'Agendamento',
        titulo: 'Fisioterapeuta ausente',
        mensagem: `${primeiroNome(consulta.FisioterapeutaNome, 'O fisioterapeuta')} não compareceu${data ? ` à consulta de ${data}` : ''}. Escolha como prosseguir.`,
        referenciaId: Number(consulta.Id),
        dados: dadosBase('fisioterapeuta_ausente', { consultaId: Number(consulta.Id) })
      }
    );
  });
}

async function pacienteAusente({ consultaId }) {
  return safeDispatch('pacienteAusente', async () => {
    const consulta = await buscarConsultaResumo(consultaId);
    if (!consulta) return null;

    const data = formatarDataHora(consulta.DataHora);
    const payload = dadosBase('paciente_ausente', { consultaId: Number(consulta.Id) });
    await enfileirar(
      { usuarioTipo: 'Paciente', usuarioId: consulta.PacienteId },
      {
        tipo: 'Agendamento',
        titulo: 'Falta registrada',
        mensagem: `Você consta como ausente${data ? ` na consulta de ${data}` : ''}.`,
        referenciaId: Number(consulta.Id),
        dados: payload
      }
    );

    return enfileirar(
      { usuarioTipo: 'Fisioterapeuta', usuarioId: consulta.FisioterapeutaId },
      {
        tipo: 'Agendamento',
        titulo: 'Paciente ausente',
        mensagem: `${primeiroNome(consulta.PacienteNome, 'O paciente')} não compareceu${data ? ` à consulta de ${data}` : ''}.`,
        referenciaId: Number(consulta.Id),
        dados: payload
      }
    );
  });
}

async function pagamentoConfirmadoConsulta({ transacaoId = null, consultaId = null }) {
  return safeDispatch('pagamentoConfirmadoConsulta', async () => {
    const refConsultaId = asId(consultaId) ?? await buscarTransacaoConsultaId(transacaoId);
    const consulta = await buscarConsultaResumo(refConsultaId);
    if (!consulta) return null;

    const data = formatarDataHora(consulta.DataHora);
    const payload = dadosBase('pagamento_consulta_confirmado', {
      consultaId: Number(consulta.Id),
      transacaoId: asId(transacaoId),
      codigoContratacao: `AGD-${new Date().getFullYear()}-${String(Number(consulta.Id)).padStart(6, '0')}`,
      contratacaoEm: new Date().toISOString(),
      pacienteId: Number(consulta.PacienteId),
      pacienteNome: consulta.PacienteNome ?? null,
      fisioterapeutaId: Number(consulta.FisioterapeutaId),
      fisioterapeutaNome: consulta.FisioterapeutaNome ?? null,
      fisioterapeutaCrefito: consulta.FisioterapeutaCrefito ?? null,
      fisioterapeutaCnpj: consulta.FisioterapeutaCnpj ?? null,
      dataHoraConsulta: consulta.DataHora ?? null,
      dataConsultaTexto: data,
      enderecoAtendimento: enderecoAtendimentoConsulta(consulta) || null,
      valorTotal: consulta.ValorConsulta ?? null
    });

    return enfileirarPushEEmail(
      { usuarioTipo: 'Paciente', usuarioId: consulta.PacienteId },
      {
        tipo: 'Pagamento',
        titulo: 'Pagamento confirmado',
        mensagem: `Recebemos seu pagamento referente à consulta${data ? ` de ${data}` : ''}.`,
        referenciaId: Number(consulta.Id),
        dados: payload
      }
    );
  });
}

async function pagamentoConfirmadoPacote({ pacoteId }) {
  return safeDispatch('pagamentoConfirmadoPacote', async () => {
    const pacote = await buscarPacoteResumo(pacoteId);
    if (!pacote) return null;

    return enfileirar(
      { usuarioTipo: 'Paciente', usuarioId: pacote.PacienteId },
      {
        tipo: 'Pagamento',
        titulo: 'Pacote ativado',
        mensagem: `Seu pacote de consultas com ${primeiroNome(pacote.FisioterapeutaNome, 'o fisioterapeuta')} foi ativado.`,
        referenciaId: Number(pacote.Id),
        dados: dadosBase('pagamento_pacote_confirmado', {
          pacoteId: Number(pacote.Id),
          fisioterapeutaId: Number(pacote.FisioterapeutaId)
        })
      }
    );
  });
}

async function pacoteCancelado({ pacoteId }) {
  return safeDispatch('pacoteCancelado', async () => {
    const pacote = await buscarPacoteResumo(pacoteId);
    if (!pacote) return null;
    if (await jaExisteEventoPacote({
      usuarioId: pacote.PacienteId,
      pacoteId: pacote.Id,
      evento: 'pacote_cancelado'
    })) return null;

    return enfileirar(
      { usuarioTipo: 'Paciente', usuarioId: pacote.PacienteId },
      {
        tipo: 'Pagamento',
        titulo: 'Pacote cancelado',
        mensagem: `Seu pacote de consultas com ${primeiroNome(pacote.FisioterapeutaNome, 'o fisioterapeuta')} foi cancelado.`,
        referenciaId: Number(pacote.Id),
        dados: dadosBase('pacote_cancelado', {
          pacoteId: Number(pacote.Id),
          fisioterapeutaId: Number(pacote.FisioterapeutaId)
        })
      }
    );
  });
}

async function reembolsoPacoteSolicitado({ pacoteId }) {
  return safeDispatch('reembolsoPacoteSolicitado', async () => {
    const pacote = await buscarPacoteResumo(pacoteId);
    if (!pacote) return null;
    if (await jaExisteEventoPacote({
      usuarioId: pacote.PacienteId,
      pacoteId: pacote.Id,
      evento: 'reembolso_pacote_solicitado'
    })) return null;

    return enfileirar(
      { usuarioTipo: 'Paciente', usuarioId: pacote.PacienteId },
      {
        tipo: 'Pagamento',
        titulo: 'Reembolso solicitado',
        mensagem: `Solicitamos o reembolso do seu pacote de consultas com ${primeiroNome(pacote.FisioterapeutaNome, 'o fisioterapeuta')}.`,
        referenciaId: Number(pacote.Id),
        dados: dadosBase('reembolso_pacote_solicitado', {
          pacoteId: Number(pacote.Id),
          fisioterapeutaId: Number(pacote.FisioterapeutaId)
        })
      }
    );
  });
}

async function reembolsoPacoteConcluido({ pacoteId }) {
  return safeDispatch('reembolsoPacoteConcluido', async () => {
    const pacote = await buscarPacoteResumo(pacoteId);
    if (!pacote) return null;
    if (await jaExisteEventoPacote({
      usuarioId: pacote.PacienteId,
      pacoteId: pacote.Id,
      evento: 'reembolso_pacote_concluido'
    })) return null;

    return enfileirar(
      { usuarioTipo: 'Paciente', usuarioId: pacote.PacienteId },
      {
        tipo: 'Pagamento',
        titulo: 'Reembolso concluído',
        mensagem: `O reembolso do seu pacote de consultas com ${primeiroNome(pacote.FisioterapeutaNome, 'o fisioterapeuta')} foi concluído.`,
        referenciaId: Number(pacote.Id),
        dados: dadosBase('reembolso_pacote_concluido', {
          pacoteId: Number(pacote.Id),
          fisioterapeutaId: Number(pacote.FisioterapeutaId)
        })
      }
    );
  });
}

async function reembolsoPacoteNegado({ pacoteId, motivo = null }) {
  return safeDispatch('reembolsoPacoteNegado', async () => {
    const pacote = await buscarPacoteResumo(pacoteId);
    if (!pacote) return null;
    if (await jaExisteEventoPacote({
      usuarioId: pacote.PacienteId,
      pacoteId: pacote.Id,
      evento: 'reembolso_pacote_negado'
    })) return null;

    return enfileirar(
      { usuarioTipo: 'Paciente', usuarioId: pacote.PacienteId },
      {
        tipo: 'Pagamento',
        titulo: 'Reembolso negado',
        mensagem: `O reembolso do seu pacote de consultas com ${primeiroNome(pacote.FisioterapeutaNome, 'o fisioterapeuta')} não foi aprovado. Abra o suporte para acompanhar.`,
        referenciaId: Number(pacote.Id),
        dados: dadosBase('reembolso_pacote_negado', {
          pacoteId: Number(pacote.Id),
          fisioterapeutaId: Number(pacote.FisioterapeutaId),
          motivo: limitar(motivo, 300) || null
        })
      }
    );
  });
}

async function chatNovaMensagem({ consultaId, mensagemId = null, remetenteTipo = null, conteudo = null }) {
  return safeDispatch('chatNovaMensagem', async () => {
    const consulta = await buscarConsultaResumo(consultaId);
    if (!consulta) return null;

    const tipoRemetente = texto(remetenteTipo);
    const destinatario = tipoRemetente === 'Paciente'
      ? { usuarioTipo: 'Fisioterapeuta', usuarioId: consulta.FisioterapeutaId, nomeRemetente: consulta.PacienteNome }
      : tipoRemetente === 'Fisioterapeuta'
        ? { usuarioTipo: 'Paciente', usuarioId: consulta.PacienteId, nomeRemetente: consulta.FisioterapeutaNome }
        : null;

    if (!destinatario) return null;
    if (await jaExisteChatRecente({
      usuarioTipo: destinatario.usuarioTipo,
      usuarioId: destinatario.usuarioId,
      consultaId: consulta.Id
    })) {
      return null;
    }

    return enfileirar(destinatario, {
      tipo: 'Chat',
      titulo: 'Nova mensagem',
      mensagem: `${primeiroNome(destinatario.nomeRemetente, 'Alguém')}: ${trechoMensagem(conteudo)}`,
      referenciaId: Number(consulta.Id),
      dados: dadosBase('chat_mensagem', {
        consultaId: Number(consulta.Id),
        chatId: asId(mensagemId),
        mensagemId: asId(mensagemId)
      })
    });
  });
}

async function disputaAberta({ disputaId = null, consultaId = null }) {
  return safeDispatch('disputaAberta', async () => {
    const disputa = await buscarDisputaResumo(disputaId, consultaId);
    if (!disputa) return null;

    const payload = dadosBase('disputa_aberta', {
      disputaId: asId(disputa.Id),
      consultaId: Number(disputa.ConsultaId),
      pacienteNome: disputa.PacienteNome ?? null
    });
    const data = formatarDataHora(disputa.DataHora);

    await enfileirarPushEEmail(
      { usuarioTipo: 'Paciente', usuarioId: disputa.PacienteId },
      {
        tipo: 'Disputa',
        titulo: 'Disputa aberta',
        mensagem: `Sua disputa foi aberta referente à consulta ${Number(disputa.ConsultaId)}.`,
        referenciaId: Number(disputa.ConsultaId),
        dados: payload
      },
      {
        emailNotificacao: {
          tipo: 'Disputa',
          titulo: 'Disputa aberta',
          mensagem: `Confirmamos o recebimento da sua disputa referente à consulta ${Number(disputa.ConsultaId)}.`,
          referenciaId: Number(disputa.ConsultaId),
          dados: { ...payload, emailModelo: 'disputa_aberta_paciente' }
        }
      }
    );

    return enfileirarPushEEmail(
      { usuarioTipo: 'Fisioterapeuta', usuarioId: disputa.FisioterapeutaId },
      {
        tipo: 'Disputa',
        titulo: 'Disputa aberta',
        mensagem: `Uma contestação foi aberta para a consulta com ${primeiroNome(disputa.PacienteNome, 'o paciente')}.`,
        referenciaId: Number(disputa.ConsultaId),
        dados: payload
      },
      {
        emailNotificacao: {
          tipo: 'Disputa',
          titulo: 'Disputa aberta',
          mensagem: `Foi registrada uma contestação relacionada à consulta com ${primeiroNome(disputa.PacienteNome, 'o paciente')}.`,
          referenciaId: Number(disputa.ConsultaId),
          dados: { ...payload, emailModelo: 'disputa_aberta_fisioterapeuta' }
        }
      }
    );
  });
}

async function disputaAtualizada({ disputaId, status = null }) {
  return safeDispatch('disputaAtualizada', async () => {
    const disputa = await buscarDisputaResumo(disputaId);
    if (!disputa) return null;

    const statusTexto = texto(status ?? disputa.Status, 'atualizada');
    const payload = dadosBase('disputa_atualizada', {
      disputaId: Number(disputa.Id),
      consultaId: Number(disputa.ConsultaId),
      status: statusTexto
    });
    const data = formatarDataHora(disputa.DataHora);

    await enfileirarPushEEmail(
      { usuarioTipo: 'Paciente', usuarioId: disputa.PacienteId },
      {
        tipo: 'Disputa',
        titulo: 'Disputa atualizada',
        mensagem: `Houve atualização na disputa da consulta ${Number(disputa.ConsultaId)}.`,
        referenciaId: Number(disputa.ConsultaId),
        dados: payload
      }
    );

    return enfileirarPushEEmail(
      { usuarioTipo: 'Fisioterapeuta', usuarioId: disputa.FisioterapeutaId },
      {
        tipo: 'Disputa',
        titulo: 'Disputa atualizada',
        mensagem: `Houve atualização na disputa da consulta ${Number(disputa.ConsultaId)}.`,
        referenciaId: Number(disputa.ConsultaId),
        dados: payload
      }
    );
  });
}

async function chamadoAberto({ chamadoId }) {
  return safeDispatch('chamadoAberto', async () => {
    const chamado = await buscarChamadoResumo(chamadoId);
    if (!chamado || !['Paciente', 'Fisioterapeuta'].includes(chamado.UsuarioTipo)) return null;

    return enfileirarPushEEmail(
      { usuarioTipo: chamado.UsuarioTipo, usuarioId: chamado.UsuarioId },
      {
        tipo: 'Chamado',
        titulo: 'Chamado aberto',
        mensagem: `Recebemos seu chamado${chamado.ProtocoloTexto ? ` ${chamado.ProtocoloTexto}` : ''}.`,
        referenciaId: Number(chamado.Id),
        dados: dadosBase('chamado_aberto', { chamadoId: Number(chamado.Id) })
      },
      {
        emailNotificacao: {
          tipo: 'Chamado',
          titulo: 'Chamado aberto',
          mensagem: `Confirmamos o recebimento do seu chamado${chamado.ProtocoloTexto ? ` ${chamado.ProtocoloTexto}` : ''}.`,
          referenciaId: Number(chamado.Id),
          dados: dadosBase('chamado_aberto', {
            chamadoId: Number(chamado.Id),
            emailModelo: 'chamado_aberto',
            protocoloTexto: chamado.ProtocoloTexto ?? null,
          })
        }
      }
    );
  });
}

async function chamadoAtualizado({ chamadoId, status = null }) {
  return safeDispatch('chamadoAtualizado', async () => {
    const chamado = await buscarChamadoResumo(chamadoId);
    if (!chamado || !['Paciente', 'Fisioterapeuta'].includes(chamado.UsuarioTipo)) return null;

    return enfileirarPushEEmail(
      { usuarioTipo: chamado.UsuarioTipo, usuarioId: chamado.UsuarioId },
      {
        tipo: 'Chamado',
        titulo: 'Chamado atualizado',
        mensagem: `Seu chamado${chamado.ProtocoloTexto ? ` ${chamado.ProtocoloTexto}` : ''} foi atualizado para ${texto(status ?? chamado.Status, 'novo status')}.`,
        referenciaId: Number(chamado.Id),
        dados: dadosBase('chamado_atualizado', {
          chamadoId: Number(chamado.Id),
          status: texto(status ?? chamado.Status)
        })
      }
    );
  });
}

async function repasseConcluido({ loteId }) {
  return safeDispatch('repasseConcluido', async () => {
    const id = asId(loteId);
    if (!id) return null;

    const destinatarios = await buscarRepasseConcluidoDestinatarios(id);
    if (destinatarios.length === 0) return null;

    const envios = [];
    for (const destino of destinatarios) {
      const fisioterapeutaId = asId(destino.FisioterapeutaId);
      if (!fisioterapeutaId) continue;

      if (await jaExisteRepasseConcluido({ fisioterapeutaId, loteId: id })) {
        continue;
      }

      const valor = Number(destino.ValorTransferido ?? 0);
      const valorTexto = formatarMoeda(valor);
      envios.push(enfileirar(
        { usuarioTipo: 'Fisioterapeuta', usuarioId: fisioterapeutaId },
        {
          tipo: 'Pagamento',
          titulo: 'Repasse concluído',
          mensagem: `Seu repasse FisioHelp${valorTexto ? ` de ${valorTexto}` : ''} foi concluído.`,
          referenciaId: id,
          dados: dadosBase('repasse_concluido', {
            loteId: id,
            fisioterapeutaId,
            valor: Number.isFinite(valor) && valor > 0 ? valor : null
          })
        },
        { canal: 'email', gravarInbox: true }
      ));
    }

    if (envios.length === 0) return null;
    const resultados = await Promise.all(envios);
    return resultados.find(Boolean) ?? null;
  });
}

async function crefitoAprovado({ fisioterapeutaId }) {
  return safeDispatch('crefitoAprovado', async () => {
    const fisio = await buscarFisioterapeutaResumo(fisioterapeutaId);
    if (!fisio) return null;

    const destinatario = { usuarioTipo: 'Fisioterapeuta', usuarioId: fisio.Id };
    const dados = dadosBase('crefito_aprovado', { fisioterapeutaId: Number(fisio.Id) });

    const push = await enfileirar(
      destinatario,
      {
        tipo: 'Credenciamento',
        titulo: 'CREFITO verificado',
        mensagem: 'Seu CREFITO foi aprovado. Seu perfil já está ativo.',
        referenciaId: Number(fisio.Id),
        dados
      }
    );

    const nome = String(fisio.Nome || 'Fisioterapeuta').trim();
    const email = await enfileirar(
      destinatario,
      {
        tipo: 'Credenciamento',
        titulo: 'Seu CREFITO foi aprovado',
        mensagem: `Olá, ${nome},

Seu CREFITO foi verificado e aprovado com sucesso.

Seu perfil já está ativo na FisioHelp. Agora você pode acessar a plataforma, revisar suas informações profissionais e começar a utilizar os recursos disponíveis para fisioterapeutas.

Atenciosamente,
Equipe FisioHelp`,
        referenciaId: Number(fisio.Id),
        dados
      },
      { canal: 'email', gravarInbox: false }
    );

    return push ?? email;
  });
}

const notificacoesDispatch = {
  consultaAgendada,
  consultaConfirmada,
  consultaReagendada,
  tokenConsultaGerado,
  consultaConcluida,
  consultaCancelada,
  fisioterapeutaAusente,
  pacienteAusente,
  pagamentoConfirmadoConsulta,
  pagamentoConfirmadoPacote,
  pacoteCancelado,
  reembolsoPacoteSolicitado,
  reembolsoPacoteConcluido,
  reembolsoPacoteNegado,
  chatNovaMensagem,
  disputaAberta,
  disputaAtualizada,
  chamadoAberto,
  chamadoAtualizado,
  repasseConcluido,
  crefitoAprovado
};

export {
  consultaAgendada,
  consultaConfirmada,
  consultaReagendada,
  tokenConsultaGerado,
  consultaConcluida,
  consultaCancelada,
  fisioterapeutaAusente,
  pacienteAusente,
  pagamentoConfirmadoConsulta,
  pagamentoConfirmadoPacote,
  pacoteCancelado,
  reembolsoPacoteSolicitado,
  reembolsoPacoteConcluido,
  reembolsoPacoteNegado,
  chatNovaMensagem,
  disputaAberta,
  disputaAtualizada,
  chamadoAberto,
  chamadoAtualizado,
  repasseConcluido,
  crefitoAprovado
};

export default notificacoesDispatch;
