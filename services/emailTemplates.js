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

function rodapeHtml() {
  return `
    <p style="margin:0 0 14px 0;">${escapeHtml(FOOTER)}</p>
    <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0;">
      <tr>
        <td style="padding:0 8px 0 0;color:#6f5a4c;font-size:13px;line-height:28px;">Siga a FisioHelp nas redes sociais:</td>
        <td style="padding:0 6px 0 0;">
          <a href="${escapeHtml(LINKEDIN_URL)}" aria-label="LinkedIn da FisioHelp" style="display:inline-block;width:28px;height:28px;border-radius:50%;background:#0A66C2;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:28px;text-align:center;text-decoration:none;font-weight:700;">in</a>
        </td>
        <td style="padding:0;">
          <a href="${escapeHtml(INSTAGRAM_URL)}" aria-label="Instagram da FisioHelp" style="display:inline-block;width:28px;height:28px;border-radius:50%;background:#F46337;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:28px;text-align:center;text-decoration:none;font-weight:700;">IG</a>
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

function montarShell({ assunto, conteudoHtml, conteudoTexto }) {
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
    linhaResumo('Data', dataConsulta),
    linhaResumo('Hora', horaConsulta),
    linhaResumo('Local de atendimento', endereco),
    linhaResumo('Valor total', valorTotal),
  ].join('');

  const conteudoHtml = `
    <h1 style="margin:0 0 18px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">${escapeHtml(assunto)}</h1>
    <p style="margin:0 0 16px 0;color:#3D2B22;font-size:16px;line-height:1.6;">Olá, ${escapeHtml(primeiroNome(pacienteNome, 'Paciente'))},</p>
    <p style="margin:0 0 22px 0;color:#3D2B22;font-size:16px;line-height:1.6;">Confirmamos que recebemos a sua aceitação da oferta e que o seu agendamento pela plataforma FisioHelp foi registrado com sucesso.</p>

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

Confirmamos que recebemos a sua aceitação da oferta e que o seu agendamento pela plataforma FisioHelp foi registrado com sucesso.

Código da Contratação: ${codigo}
Número do Agendamento: ${numeroAgendamento}
Data da Contratação: ${dataContratacao}
Status de Pagamento: Confirmado

Resumo da Consulta

Profissional: ${fisioterapeutaNome}
Registro profissional: CREFITO ${crefito}
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

export function montarEmailNotificacao({ titulo, mensagem, dados = null } = {}) {
  if (dados?.tipo === 'pagamento_consulta_confirmado') {
    return montarEmailPagamentoConsulta(dados);
  }

  const assunto = normalizarAssunto(titulo);
  const mensagemTexto = normalizarMensagem(mensagem);
  const assuntoHtml = escapeHtml(assunto);
  const mensagemHtml = escapeHtml(mensagemTexto || 'Você recebeu uma nova mensagem da FisioHelp.');

  return montarShell({
    assunto,
    conteudoHtml: `
      <h1 style="margin:0 0 16px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">${assuntoHtml}</h1>
      <div style="color:#3D2B22;font-size:16px;line-height:1.6;white-space:pre-line;">${mensagemHtml}</div>`,
    conteudoTexto: `${assunto}

${mensagemTexto || 'Você recebeu uma nova mensagem da FisioHelp.'}`,
  });
}

export default {
  montarEmailNotificacao,
  escapeHtml,
};
