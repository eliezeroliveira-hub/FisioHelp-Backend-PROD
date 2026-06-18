import { formatCNPJ } from '../utils/identityValidators.js';

const FOOTER = 'Mensagem automática — esta caixa não é monitorada. Fale com suporte@fisiohelp.com.br.';
const FALLBACK_SUBJECT = 'Mensagem da FisioHelp';
const TERMOS_URL = 'https://fisiohelp.com.br/termos-de-uso';
const PRIVACIDADE_URL = 'https://fisiohelp.com.br/politica-de-privacidade';
const INSTAGRAM_URL = 'https://www.instagram.com/fisiohelp.br?utm_source=qr';
const LINKEDIN_URL = 'https://www.linkedin.com/company/fisiohelpbr/';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizarAssunto(titulo) {
  const assunto = String(titulo ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (assunto || FALLBACK_SUBJECT).slice(0, 200);
}

function normalizarMensagem(mensagem) {
  return String(mensagem ?? '').trim();
}

function texto(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function primeiroNome(value, fallback = 'usuario') {
  return texto(value, fallback).split(/\s+/)[0] || fallback;
}

function formatarMoeda(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  return numero.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarCnpj(value) {
  return formatCNPJ(value);
}

function formatarDataHora(value) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date).replace(',', ' às');
  }

  return texto(value);
}

function formatarData(value) {
  const dataHora = formatarDataHora(value);
  if (!dataHora) return null;
  return dataHora.split(' às ')[0] || dataHora;
}

function formatarHora(value) {
  const dataHora = formatarDataHora(value);
  if (!dataHora) return null;
  return dataHora.split(' às ')[1] || null;
}

function codigoContratacao(consultaId, contratacaoEm) {
  const id = Number(consultaId);
  const date = contratacaoEm ? new Date(contratacaoEm) : new Date();
  const ano = Number.isNaN(date.getTime()) ? new Date().getFullYear() : date.getFullYear();
  return `AGD-${ano}-${String(Number.isInteger(id) && id > 0 ? id : 0).padStart(6, '0')}`;
}

function linkHtml(label, href) {
  const safeHref = escapeHtml(href);
  return `<a href="${safeHref}" style="color:#F46337;font-weight:700;text-decoration:none;">${escapeHtml(label)}</a>`;
}

function linhaResumo(label, value) {
  const safeValue = texto(value, '-');
  return `
    <tr>
      <td style="padding:8px 0;color:#6f5a4c;font-size:14px;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:8px 0;color:#3D2B22;font-size:14px;font-weight:700;text-align:right;vertical-align:top;">${escapeHtml(safeValue)}</td>
    </tr>`;
}

function blocoTextoHtml(titulo, conteudo) {
  return `
    <div style="margin:0 0 18px 0;">
      <p style="margin:0 0 6px 0;color:#3D2B22;font-size:15px;font-weight:700;">${escapeHtml(titulo)}</p>
      <p style="margin:0;color:#3D2B22;font-size:15px;line-height:1.6;">${escapeHtml(conteudo)}</p>
    </div>`;
}

function textoMensagemHtml(value) {
  const partes = String(value ?? '').split('**');
  return partes
    .map((parte, index) => {
      const conteudo = escapeHtml(parte);
      return index % 2 === 1
        ? `<strong style="font-weight:700;">${conteudo}</strong>`
        : conteudo;
    })
    .join('');
}

function paragrafoHtml(conteudo) {
  return `<p style="margin:0 0 16px 0;color:#3D2B22;font-size:16px;line-height:1.6;">${textoMensagemHtml(conteudo)}</p>`;
}

function tituloSecaoHtml(conteudo) {
  return `<h2 style="margin:0 0 10px 0;color:#3D2B22;font-size:18px;line-height:1.4;">${escapeHtml(conteudo)}</h2>`;
}

function rodapeHtml() {
  return `
    <p style="margin:0 0 14px 0;">${escapeHtml(FOOTER)}</p>
    <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0;">
      <tr>
        <td style="padding:0 8px 0 0;color:#6f5a4c;font-size:13px;line-height:28px;">Siga a FisioHelp nas redes sociais:</td>
        <td style="padding:0 6px 0 0;">
          <a href="${escapeHtml(INSTAGRAM_URL)}" aria-label="Instagram da FisioHelp" style="display:inline-block;width:36px;height:36px;border-radius:10px;background:#FDF4E0;border:1px solid rgba(61,43,34,0.16);text-align:center;text-decoration:none;line-height:36px;">
            <span style="display:inline-block;width:16px;height:16px;border:2px solid #3D2B22;border-radius:5px;vertical-align:middle;line-height:16px;text-align:center;">
              <span style="display:inline-block;width:5px;height:5px;border:2px solid #3D2B22;border-radius:50%;vertical-align:middle;"></span>
            </span>
          </a>
        </td>
        <td style="padding:0;">
          <a href="${escapeHtml(LINKEDIN_URL)}" aria-label="LinkedIn da FisioHelp" style="display:inline-block;width:36px;height:36px;border-radius:10px;background:#FDF4E0;border:1px solid rgba(61,43,34,0.16);color:#3D2B22;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:36px;text-align:center;text-decoration:none;font-weight:700;">in</a>
        </td>
      </tr>
    </table>`;
}

function rodapeTexto() {
  return `${FOOTER}

Siga a FisioHelp nas redes sociais:
LinkedIn: ${LINKEDIN_URL}
Instagram: ${INSTAGRAM_URL}`;
}

export function montarShell({ assunto, conteudoHtml, conteudoTexto }) {
  const assuntoHtml = escapeHtml(assunto);

  const corpoHtml = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${assuntoHtml}</title>
  </head>
  <body style="margin:0;padding:0;background:#FDF4E0;color:#3D2B22;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#FDF4E0;margin:0;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid rgba(61,43,34,0.12);border-radius:8px;overflow:hidden;">
            <tr>
              <td style="background:#F46337;color:#ffffff;padding:22px 24px;font-size:22px;font-weight:700;">
                FisioHelp
              </td>
            </tr>
            <tr>
              <td style="padding:28px 24px 16px 24px;">
                ${conteudoHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 24px 24px 24px;color:#6f5a4c;font-size:13px;line-height:1.5;border-top:1px solid rgba(61,43,34,0.10);">
                ${rodapeHtml()}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return {
    assunto,
    corpoHtml,
    corpoTexto: `${conteudoTexto}

${rodapeTexto()}`,
  };
}

function montarEmailPagamentoConsulta(dados = {}) {
  const fisioterapeutaNome = texto(dados.fisioterapeutaNome, 'Fisioterapeuta');
  const pacienteNome = texto(dados.pacienteNome, 'Paciente');
  const consultaId = Number(dados.consultaId);
  const contratacaoEm = dados.contratacaoEm || new Date().toISOString();
  const dataHoraConsultaTexto = texto(dados.dataConsultaTexto);
  const dataConsulta = dataHoraConsultaTexto
    ? (dataHoraConsultaTexto.split(',')[0] || dataHoraConsultaTexto).trim()
    : formatarData(dados.dataHoraConsulta);
  const horaConsulta = dataHoraConsultaTexto
    ? ((dataHoraConsultaTexto.split(',')[1] || '').trim() || null)
    : formatarHora(dados.dataHoraConsulta);
  const valorTotal = formatarMoeda(dados.valorTotal);
  const endereco = texto(dados.enderecoAtendimento, 'Endereço cadastrado na plataforma');
  const crefito = texto(dados.fisioterapeutaCrefito, 'não informado');
  const cnpj = texto(formatarCnpj(dados.fisioterapeutaCnpj), 'não informado');
  const codigo = texto(dados.codigoContratacao, codigoContratacao(consultaId, contratacaoEm));
  const numeroAgendamento = Number.isInteger(consultaId) && consultaId > 0 ? `#${consultaId}` : '-';
  const dataContratacao = formatarDataHora(contratacaoEm) || texto(contratacaoEm, '-');
  const assunto = `Confirmação de Agendamento — ${fisioterapeutaNome} via FisioHelp`;

  const resumoRows = [
    linhaResumo('Código da contratação', codigo),
    linhaResumo('Número do agendamento', numeroAgendamento),
    linhaResumo('Data da contratação', dataContratacao),
    linhaResumo('Status de pagamento', 'Confirmado'),
    linhaResumo('Profissional', fisioterapeutaNome),
    linhaResumo('Registro profissional', `CREFITO ${crefito}`),
    linhaResumo('CNPJ do Profissional', cnpj),
    linhaResumo('Data', dataConsulta),
    linhaResumo('Hora', horaConsulta),
    linhaResumo('Local de atendimento', endereco),
    linhaResumo('Valor total', valorTotal),
  ].join('');

  const conteudoHtml = `
    <h1 style="margin:0 0 18px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">${escapeHtml(assunto)}</h1>
    <p style="margin:0 0 16px 0;color:#3D2B22;font-size:16px;line-height:1.6;">Olá, ${escapeHtml(primeiroNome(pacienteNome, 'Paciente'))},</p>
    <p style="margin:0 0 22px 0;color:#3D2B22;font-size:16px;line-height:1.6;">Confirmamos que recebemos a sua aceitação da oferta e que o seu agendamento pela plataforma FisioHelp foi registrado com sucesso. O fisioterapeuta será notificado para confirmar o agendamento no aplicativo. Após a confirmação, você receberá um novo e-mail.</p>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;border-top:1px solid rgba(61,43,34,0.10);border-bottom:1px solid rgba(61,43,34,0.10);">
      ${resumoRows}
    </table>

    <h2 style="margin:0 0 10px 0;color:#3D2B22;font-size:18px;line-height:1.4;">Documentos aceitos nesta contratação</h2>
    <p style="margin:0 0 10px 0;color:#3D2B22;font-size:15px;line-height:1.6;">Ao concluir o agendamento, você confirmou ciência e aceitação dos documentos aplicáveis à plataforma FisioHelp:</p>
    <p style="margin:0 0 22px 0;color:#3D2B22;font-size:15px;line-height:1.8;">
      ${linkHtml('Termos de Uso', TERMOS_URL)}<br>
      ${linkHtml('Política de Privacidade', PRIVACIDADE_URL)}
    </p>
    <p style="margin:-10px 0 22px 0;color:#3D2B22;font-size:15px;line-height:1.6;">Você poderá consultar esses documentos a qualquer momento pelos links acima.</p>

    <h2 style="margin:0 0 12px 0;color:#3D2B22;font-size:18px;line-height:1.4;">Lembretes importantes para o atendimento</h2>
    ${blocoTextoHtml('Direito de arrependimento', 'Você poderá exercer o direito de arrependimento em até 7 dias corridos da contratação, observadas as hipóteses previstas na legislação aplicável e nos Termos de Uso da plataforma.')}
    ${blocoTextoHtml('Validação por token', 'Quando o profissional chegar ao local de atendimento, ele gerará um código de validação de 6 dígitos no aplicativo. Esse código deverá ser confirmado presencialmente para validação e conclusão do atendimento.')}
    ${blocoTextoHtml('Regra de ausência', 'Caso o atendimento não seja validado conforme as regras da plataforma, a situação será tratada de acordo com as regras de ausência previstas nos Termos de Uso, sem geração automática de reembolso.')}
    ${blocoTextoHtml('Comunicação direta', 'O canal de chat com o profissional está disponível no aplicativo para alinhamento de detalhes sobre o atendimento.')}
    ${blocoTextoHtml('Suporte e contestações', 'Caso ocorra qualquer imprevisto ou falha na prestação do serviço, você poderá entrar em contato pelo canal Fale Conosco da plataforma. Nossa equipe analisará a solicitação e enviará resposta oficial conforme os prazos previstos nos Termos de Uso.')}

    <h2 style="margin:4px 0 10px 0;color:#3D2B22;font-size:18px;line-height:1.4;">Canais de contato</h2>
    <p style="margin:0;color:#3D2B22;font-size:15px;line-height:1.7;">
      Suporte: <a href="mailto:suporte@fisiohelp.com.br" style="color:#F46337;font-weight:700;text-decoration:none;">suporte@fisiohelp.com.br</a><br>
      Privacidade e LGPD: <a href="mailto:privacidade@fisiohelp.com.br" style="color:#F46337;font-weight:700;text-decoration:none;">privacidade@fisiohelp.com.br</a>
    </p>

    <p style="margin:24px 0 0 0;color:#3D2B22;font-size:15px;line-height:1.6;">Atenciosamente,<br>Equipe FisioHelp</p>
    <p style="margin:12px 0 0 0;color:#6f5a4c;font-size:13px;line-height:1.5;">FisioHelp Intermediação de Negócios Tecnológicos Ltda.<br>CNPJ 67.039.614/0001-58</p>`;

  const conteudoTexto = `${assunto}

Olá, ${primeiroNome(pacienteNome, 'Paciente')},

Confirmamos que recebemos a sua aceitação da oferta e que o seu agendamento pela plataforma FisioHelp foi registrado com sucesso. O fisioterapeuta será notificado para confirmar o agendamento no aplicativo. Após a confirmação, você receberá um novo e-mail.

Código da Contratação: ${codigo}
Número do Agendamento: ${numeroAgendamento}
Data da Contratação: ${dataContratacao}
Status de Pagamento: Confirmado

Resumo da Consulta

Profissional: ${fisioterapeutaNome}
Registro profissional: CREFITO ${crefito}
CNPJ do Profissional: ${cnpj}
Data e hora: ${dataConsulta || '-'}${horaConsulta ? ` às ${horaConsulta}` : ''}
Local de atendimento: ${endereco}
Valor total: ${valorTotal || '-'}

Documentos aceitos nesta contratação

Ao concluir o agendamento, você confirmou ciência e aceitação dos documentos aplicáveis à plataforma FisioHelp:

Termos de Uso: ${TERMOS_URL}
Política de Privacidade: ${PRIVACIDADE_URL}

Você poderá consultar esses documentos a qualquer momento pelos links acima.

Lembretes importantes para o atendimento

Direito de arrependimento:
Você poderá exercer o direito de arrependimento em até 7 dias corridos da contratação, observadas as hipóteses previstas na legislação aplicável e nos Termos de Uso da plataforma.

Validação por token:
Quando o profissional chegar ao local de atendimento, ele gerará um código de validação de 6 dígitos no aplicativo. Esse código deverá ser confirmado presencialmente para validação e conclusão do atendimento.

Regra de ausência:
Caso o atendimento não seja validado conforme as regras da plataforma, a situação será tratada de acordo com as regras de ausência previstas nos Termos de Uso, sem geração automática de reembolso.

Comunicação direta:
O canal de chat com o profissional está disponível no aplicativo para alinhamento de detalhes sobre o atendimento.

Suporte e contestações:
Caso ocorra qualquer imprevisto ou falha na prestação do serviço, você poderá entrar em contato pelo canal Fale Conosco da plataforma. Nossa equipe analisará a solicitação e enviará resposta oficial conforme os prazos previstos nos Termos de Uso.

Canais de contato

Suporte: suporte@fisiohelp.com.br
Privacidade e LGPD: privacidade@fisiohelp.com.br

Atenciosamente,
Equipe FisioHelp

FisioHelp Intermediação de Negócios Tecnológicos Ltda.
CNPJ 67.039.614/0001-58`;

  return montarShell({ assunto, conteudoHtml, conteudoTexto });
}

function montarEmailConsultaCanceladaPaciente(dados = {}) {
  const consultaId = Number(dados.consultaId);
  const numeroConsulta = Number.isInteger(consultaId) && consultaId > 0 ? String(consultaId) : '-';
  const fisioterapeutaNome = texto(dados.fisioterapeutaNome, 'o fisioterapeuta');
  const data = texto(dados.dataConsultaTexto, 'data/hora informada no aplicativo');
  const cnpj = texto(formatarCnpj(dados.fisioterapeutaCnpj), 'não informado');
  const assunto = 'Cancelamento da consulta recebido';

  const conteudoHtml = `
    <h1 style="margin:0 0 18px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">${escapeHtml(assunto)}</h1>
    ${paragrafoHtml(`Confirmamos o recebimento da sua solicitação de cancelamento referente à consulta ${numeroConsulta} com ${fisioterapeutaNome}, agendada para ${data}.`)}
    ${tituloSecaoHtml('Resumo da consulta cancelada')}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 22px 0;border-top:1px solid rgba(61,43,34,0.10);border-bottom:1px solid rgba(61,43,34,0.10);">
      ${linhaResumo('Profissional', fisioterapeutaNome)}
      ${linhaResumo('CNPJ do Prestador', cnpj)}
    </table>
    ${paragrafoHtml('Sua solicitação foi registrada na plataforma FisioHelp e será processada conforme as regras aplicáveis dos Termos de Uso e da legislação vigente.')}
    ${paragrafoHtml('Quando houver valor pago elegível à devolução, a FisioHelp comunicará a instituição financeira ou administradora do meio de pagamento para que o estorno seja processado. O prazo de efetivação poderá variar conforme o método de pagamento e as regras da instituição responsável.')}
    ${paragrafoHtml('Você poderá acompanhar o status da solicitação pelo aplicativo.')}`;

  const conteudoTexto = `${assunto}

Confirmamos o recebimento da sua solicitação de cancelamento referente à consulta ${numeroConsulta} com ${fisioterapeutaNome}, agendada para ${data}.

Resumo da consulta cancelada:

Profissional: ${fisioterapeutaNome}
CNPJ do Prestador: ${cnpj}

Sua solicitação foi registrada na plataforma FisioHelp e será processada conforme as regras aplicáveis dos Termos de Uso e da legislação vigente.

Quando houver valor pago elegível à devolução, a FisioHelp comunicará a instituição financeira ou administradora do meio de pagamento para que o estorno seja processado. O prazo de efetivação poderá variar conforme o método de pagamento e as regras da instituição responsável.

Você poderá acompanhar o status da solicitação pelo aplicativo.`;

  return montarShell({ assunto, conteudoHtml, conteudoTexto });
}

function montarEmailDisputaAbertaPaciente(dados = {}) {
  const consultaId = Number(dados.consultaId);
  const disputaId = Number(dados.disputaId);
  const numeroConsulta = Number.isInteger(consultaId) && consultaId > 0 ? String(consultaId) : '-';
  const protocolo = Number.isInteger(disputaId) && disputaId > 0 ? String(disputaId) : '-';
  const assunto = 'Disputa aberta';

  const conteudoHtml = `
    <h1 style="margin:0 0 18px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">${escapeHtml(assunto)}</h1>
    ${paragrafoHtml(`Confirmamos o recebimento da sua disputa referente à consulta ${numeroConsulta}.`)}
    ${paragrafoHtml(`Protocolo da disputa: ${protocolo}`)}
    ${paragrafoHtml('A FisioHelp analisará sua solicitação e enviará uma resposta oficial em até 5 dias úteis.')}
    ${paragrafoHtml('Você poderá acompanhar as atualizações pelo aplicativo.')}`;

  const conteudoTexto = `${assunto}

Confirmamos o recebimento da sua disputa referente à consulta ${numeroConsulta}.

Protocolo da disputa: ${protocolo}

A FisioHelp analisará sua solicitação e enviará uma resposta oficial em até 5 dias úteis.

Você poderá acompanhar as atualizações pelo aplicativo.`;

  return montarShell({ assunto, conteudoHtml, conteudoTexto });
}

function montarEmailDisputaAbertaFisioterapeuta(dados = {}) {
  const disputaId = Number(dados.disputaId);
  const protocolo = Number.isInteger(disputaId) && disputaId > 0 ? String(disputaId) : '-';
  const pacienteNome = texto(dados.pacienteNome, 'o paciente');
  const assunto = 'Disputa aberta';

  const conteudoHtml = `
    <h1 style="margin:0 0 18px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">${escapeHtml(assunto)}</h1>
    ${paragrafoHtml(`Foi registrada uma contestação relacionada à consulta com ${pacienteNome}.`)}
    ${paragrafoHtml(`Protocolo da disputa: ${protocolo}`)}
    ${paragrafoHtml('A FisioHelp analisará a solicitação e enviará uma resposta oficial em até 5 dias úteis.')}
    ${paragrafoHtml('Você poderá apresentar informações, documentos ou evidências relacionadas ao atendimento diretamente pelo aplicativo.')}
    ${paragrafoHtml('Você poderá acompanhar as atualizações pelo aplicativo.')}`;

  const conteudoTexto = `${assunto}

Foi registrada uma contestação relacionada à consulta com ${pacienteNome}.

Protocolo da disputa: ${protocolo}

A FisioHelp analisará a solicitação e enviará uma resposta oficial em até 5 dias úteis.

Você poderá apresentar informações, documentos ou evidências relacionadas ao atendimento diretamente pelo aplicativo.

Você poderá acompanhar as atualizações pelo aplicativo.`;

  return montarShell({ assunto, conteudoHtml, conteudoTexto });
}

function montarEmailChamadoAberto(dados = {}) {
  const protocolo = texto(dados.protocoloTexto);
  const assunto = 'Chamado aberto';
  const trechoProtocolo = protocolo ? ` ${protocolo}` : '';

  const conteudoHtml = `
    <h1 style="margin:0 0 18px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">${escapeHtml(assunto)}</h1>
    ${paragrafoHtml(`Confirmamos o recebimento do seu chamado${trechoProtocolo}.`)}
    ${paragrafoHtml('A FisioHelp analisará sua solicitação e enviará uma resposta oficial em até 5 dias úteis.')}
    ${paragrafoHtml('Você poderá acompanhar as atualizações pelo aplicativo.')}`;

  const conteudoTexto = `${assunto}

Confirmamos o recebimento do seu chamado${trechoProtocolo}.

A FisioHelp analisará sua solicitação e enviará uma resposta oficial em até 5 dias úteis.

Você poderá acompanhar as atualizações pelo aplicativo.`;

  return montarShell({ assunto, conteudoHtml, conteudoTexto });
}

export function montarEmailNotificacao({ titulo, mensagem, dados = null } = {}) {
  if (dados?.emailModelo === 'consulta_cancelada_paciente') {
    return montarEmailConsultaCanceladaPaciente(dados);
  }

  if (dados?.emailModelo === 'disputa_aberta_paciente') {
    return montarEmailDisputaAbertaPaciente(dados);
  }

  if (dados?.emailModelo === 'disputa_aberta_fisioterapeuta') {
    return montarEmailDisputaAbertaFisioterapeuta(dados);
  }

  if (dados?.emailModelo === 'chamado_aberto') {
    return montarEmailChamadoAberto(dados);
  }

  if (dados?.tipo === 'pagamento_consulta_confirmado') {
    return montarEmailPagamentoConsulta(dados);
  }

  const assunto = normalizarAssunto(titulo);
  const mensagemTexto = normalizarMensagem(mensagem);
  const assuntoHtml = escapeHtml(assunto);

  return montarShell({
    assunto,
    conteudoHtml: `
      <h1 style="margin:0 0 16px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">${assuntoHtml}</h1>
      <div style="color:#3D2B22;font-size:16px;line-height:1.6;white-space:pre-line;">${textoMensagemHtml(mensagemTexto || 'Você recebeu uma nova mensagem da FisioHelp.')}</div>`,
    conteudoTexto: `${assunto}

${mensagemTexto || 'Você recebeu uma nova mensagem da FisioHelp.'}`,
  });
}

export default {
  montarEmailNotificacao,
  escapeHtml,
  montarShell,
};
