import { escapeHtml, montarShell } from './emailTemplates.js';

function texto(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function assuntoLimpo(value, fallback) {
  return texto(value, fallback).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').slice(0, 120);
}

function htmlMultilinha(value) {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, '<br>');
}

function linhaResumo(label, value) {
  return `
    <tr>
      <td style="padding:8px 0;color:#6f5a4c;font-size:14px;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:8px 0;color:#3D2B22;font-size:14px;font-weight:700;text-align:right;vertical-align:top;">${escapeHtml(texto(value, '-'))}</td>
    </tr>`;
}

export function montarEmailContatoPublicoInterno({
  nome,
  email,
  telefone,
  assunto,
  mensagem,
  ip,
  userAgent,
} = {}) {
  const assuntoUsuario = assuntoLimpo(assunto, 'Contato pelo site');
  const assuntoEmail = `[Site] ${assuntoUsuario}`;

  const conteudoHtml = `
    <h1 style="margin:0 0 18px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">Nova mensagem pelo site</h1>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;border-top:1px solid rgba(61,43,34,0.10);border-bottom:1px solid rgba(61,43,34,0.10);">
      ${linhaResumo('Nome', nome)}
      ${linhaResumo('E-mail', email)}
      ${linhaResumo('Telefone', telefone || 'não informado')}
      ${linhaResumo('Assunto', assuntoUsuario)}
      ${linhaResumo('IP', ip || 'não informado')}
      ${linhaResumo('User-Agent', userAgent || 'não informado')}
    </table>
    <h2 style="margin:0 0 10px 0;color:#3D2B22;font-size:18px;line-height:1.4;">Mensagem</h2>
    <p style="margin:0;color:#3D2B22;font-size:16px;line-height:1.7;">${htmlMultilinha(mensagem)}</p>`;

  const conteudoTexto = `Nova mensagem pelo site

Nome: ${texto(nome, '-')}
E-mail: ${texto(email, '-')}
Telefone: ${texto(telefone, 'não informado')}
Assunto: ${assuntoUsuario}
IP: ${texto(ip, 'não informado')}
User-Agent: ${texto(userAgent, 'não informado')}

Mensagem:
${texto(mensagem, '-')}`;

  return montarShell({
    assunto: assuntoEmail,
    conteudoHtml,
    conteudoTexto,
  });
}

export function montarEmailContatoPublicoConfirmacao({ nome, assunto } = {}) {
  const primeiroNome = texto(nome, 'Olá').split(/\s+/)[0] || 'Olá';
  const assuntoUsuario = assuntoLimpo(assunto, 'Contato pelo site');
  const assuntoEmail = 'Recebemos sua mensagem na FisioHelp';

  const conteudoHtml = `
    <h1 style="margin:0 0 18px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">Recebemos sua mensagem</h1>
    <p style="margin:0 0 16px 0;color:#3D2B22;font-size:16px;line-height:1.6;">Olá, ${escapeHtml(primeiroNome)},</p>
    <p style="margin:0 0 16px 0;color:#3D2B22;font-size:16px;line-height:1.6;">Recebemos sua mensagem enviada pelo site da FisioHelp.</p>
    <p style="margin:0 0 16px 0;color:#3D2B22;font-size:16px;line-height:1.6;"><strong>Assunto:</strong> ${escapeHtml(assuntoUsuario)}</p>
    <p style="margin:0;color:#3D2B22;font-size:16px;line-height:1.6;">Nossa equipe analisará o contato e responderá pelo e-mail informado, quando necessário.</p>`;

  const conteudoTexto = `${assuntoEmail}

Olá, ${primeiroNome},

Recebemos sua mensagem enviada pelo site da FisioHelp.

Assunto: ${assuntoUsuario}

Nossa equipe analisará o contato e responderá pelo e-mail informado, quando necessário.`;

  return montarShell({
    assunto: assuntoEmail,
    conteudoHtml,
    conteudoTexto,
  });
}

export default {
  montarEmailContatoPublicoInterno,
  montarEmailContatoPublicoConfirmacao,
};
