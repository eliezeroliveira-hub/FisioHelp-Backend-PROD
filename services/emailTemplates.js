const FOOTER = 'Mensagem automática — esta caixa não é monitorada. Fale com suporte@fisiohelp.com.br.';
const FALLBACK_SUBJECT = 'Mensagem da FisioHelp';

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

export function montarEmailNotificacao({ titulo, mensagem } = {}) {
  const assunto = normalizarAssunto(titulo);
  const mensagemTexto = normalizarMensagem(mensagem);
  const assuntoHtml = escapeHtml(assunto);
  const mensagemHtml = escapeHtml(mensagemTexto || 'Você recebeu uma nova mensagem da FisioHelp.');

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
                <h1 style="margin:0 0 16px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">${assuntoHtml}</h1>
                <div style="color:#3D2B22;font-size:16px;line-height:1.6;white-space:pre-line;">${mensagemHtml}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 24px 24px 24px;color:#6f5a4c;font-size:13px;line-height:1.5;border-top:1px solid rgba(61,43,34,0.10);">
                ${escapeHtml(FOOTER)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const corpoTexto = `${assunto}

${mensagemTexto || 'Você recebeu uma nova mensagem da FisioHelp.'}

${FOOTER}`;

  return {
    assunto,
    corpoHtml,
    corpoTexto,
  };
}

export default {
  montarEmailNotificacao,
  escapeHtml,
};
