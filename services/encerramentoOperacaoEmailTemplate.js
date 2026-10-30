const ASSUNTO = 'Comunicado importante: encerramento das operações da FisioHelp';
const PRIVACIDADE_URL = 'https://fisiohelp.com.br/politica-de-privacidade';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function primeiroNome(value) {
  return String(value ?? '').trim().split(/\s+/)[0] || '';
}

export function montarEmailComunicadoEncerramentoOperacao({ nomeDestinatario } = {}) {
  const nome = primeiroNome(nomeDestinatario);
  const saudacaoHtml = nome ? `Olá, ${escapeHtml(nome)}!` : 'Olá!';
  const saudacaoTexto = nome ? `Olá, ${nome}!` : 'Olá!';

  const corpoHtml = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Encerramento das operações da FisioHelp</title>
  </head>
  <body style="margin:0;padding:0;background:#f7f0e4;font-family:Arial,Helvetica,sans-serif;color:#3d2b22;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      Novos cadastros e agendamentos foram encerrados; a plataforma permanecerá disponível até 30 de novembro de 2026.
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f7f0e4;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#fffaf1;border:1px solid #ead9c3;border-radius:20px;overflow:hidden;">
            <tr>
              <td align="center" style="padding:30px 28px 22px;background:#fff7e9;border-bottom:1px solid #ead9c3;">
                <div style="font-size:28px;font-weight:700;line-height:1.2;color:#3d2b22;">
                  <span style="color:#F46337;font-family:Arial,Helvetica,sans-serif;">&#x2665;&#xFE0E;</span> FisioHelp
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:34px 34px 10px;">
                <div style="font-size:12px;font-weight:700;letter-spacing:1.6px;color:#F46337;text-transform:uppercase;margin-bottom:10px;">Comunicado importante</div>
                <h1 style="margin:0 0 20px;font-size:30px;line-height:1.18;color:#2f2019;">Encerramento das operações da FisioHelp</h1>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.65;">${saudacaoHtml}</p>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.65;">Depois de muita dedicação à construção da FisioHelp, tomamos a difícil decisão de encerrar nossas operações. Os custos operacionais e os tributos atribuídos à atividade tornaram a continuidade do serviço financeiramente inviável.</p>
                <div style="margin:24px 0;padding:20px;border-radius:14px;background:#fff1df;border:1px solid #f2d2ae;">
                  <p style="margin:0 0 12px;font-size:16px;line-height:1.55;"><strong>A partir de 30 de outubro de 2026</strong>, a FisioHelp não aceita novos cadastros, agendamentos, contratações ou pagamentos.</p>
                  <p style="margin:0;font-size:16px;line-height:1.55;"><strong>Em 30 de novembro de 2026</strong>, os perfis públicos dos fisioterapeutas serão retirados do ar, e o aplicativo e a área logada deixarão de estar disponíveis.</p>
                </div>

                <h2 style="margin:28px 0 12px;font-size:21px;line-height:1.3;color:#2f2019;">O que continua disponível até 30/11/2026</h2>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.65;">Usuários existentes ainda podem entrar na conta, consultar o histórico e acessar as informações já registradas. Pagamentos, reembolsos e repasses que estejam pendentes serão concluídos normalmente.</p>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.65;"><strong>Para fisioterapeutas:</strong> os descontos e as condições especiais das parcerias com a <strong>BCMED</strong> e a <strong>Jalecos Conforto</strong> permanecerão disponíveis até 30 de novembro de 2026.</p>

                <h2 style="margin:28px 0 12px;font-size:21px;line-height:1.3;color:#2f2019;">Prontuários e cópia dos dados</h2>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.65;">Os fisioterapeutas que possuam prontuários na plataforma receberão automaticamente uma exportação protegida dos registros no e-mail cadastrado, antes do encerramento. Não será necessário solicitar o envio.</p>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.65;">Se desejar uma cópia dos seus demais dados ou do seu histórico, envie a solicitação até 30 de novembro de 2026 para <a href="mailto:privacidade@fisiohelp.com.br" style="color:#e9552b;font-weight:700;">privacidade@fisiohelp.com.br</a>.</p>

                <h2 style="margin:28px 0 12px;font-size:21px;line-height:1.3;color:#2f2019;">Tratamento dos dados pessoais</h2>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.65;">Após o encerramento, os dados pessoais que não precisem ser mantidos serão excluídos de forma segura, de acordo com a LGPD. Os registros cuja conservação seja exigida por lei permanecerão arquivados, com acesso restrito, pelo prazo previsto em nossa <a href="${PRIVACIDADE_URL}" style="color:#e9552b;font-weight:700;">Política de Privacidade</a>.</p>

                <div style="margin:26px 0;padding:18px 20px;border-radius:14px;background:#ffffff;border:1px solid #ead9c3;">
                  <p style="margin:0 0 9px;font-size:15px;line-height:1.55;"><strong>Precisa falar conosco?</strong></p>
                  <p style="margin:0;font-size:15px;line-height:1.65;">Os canais <a href="mailto:suporte@fisiohelp.com.br" style="color:#e9552b;">suporte@fisiohelp.com.br</a> e <a href="mailto:privacidade@fisiohelp.com.br" style="color:#e9552b;">privacidade@fisiohelp.com.br</a> permanecerão disponíveis até <strong>30 de dezembro de 2026</strong>.</p>
                </div>

                <h2 style="margin:30px 0 12px;font-size:21px;line-height:1.3;color:#2f2019;">Nosso agradecimento</h2>
                <p style="margin:0 0 18px;font-size:16px;line-height:1.65;">Agradecemos a cada paciente e fisioterapeuta que confiou na FisioHelp e fez parte desta jornada. Foi uma honra trabalhar para aproximar profissionais e pessoas em busca de cuidado.</p>
                <p style="margin:0 0 28px;font-size:16px;line-height:1.65;">Com carinho,<br><strong>Equipe FisioHelp</strong></p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:22px 28px;background:#3d2b22;color:#f8eee2;">
                <p style="margin:0 0 7px;font-size:12px;line-height:1.55;">FisioHelp Intermediação de Negócios Tecnológicos Ltda.</p>
                <p style="margin:0;font-size:12px;line-height:1.55;">CNPJ 67.039.614/0001-58</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const corpoTexto = `${saudacaoTexto}

Depois de muita dedicação à construção da FisioHelp, tomamos a difícil decisão de encerrar nossas operações. Os custos operacionais e os tributos atribuídos à atividade tornaram a continuidade do serviço financeiramente inviável.

A partir de 30 de outubro de 2026, a FisioHelp não aceita novos cadastros, agendamentos, contratações ou pagamentos.

Em 30 de novembro de 2026, os perfis públicos dos fisioterapeutas serão retirados do ar, e o aplicativo e a área logada deixarão de estar disponíveis.

O que continua disponível até 30/11/2026

Usuários existentes ainda podem entrar na conta, consultar o histórico e acessar as informações já registradas. Pagamentos, reembolsos e repasses que estejam pendentes serão concluídos normalmente.

Para fisioterapeutas: os descontos e as condições especiais das parcerias com a BCMED e a Jalecos Conforto permanecerão disponíveis até 30 de novembro de 2026.

Prontuários e cópia dos dados

Os fisioterapeutas que possuam prontuários na plataforma receberão automaticamente uma exportação protegida dos registros no e-mail cadastrado, antes do encerramento. Não será necessário solicitar o envio.

Se desejar uma cópia dos seus demais dados ou do seu histórico, envie a solicitação até 30 de novembro de 2026 para privacidade@fisiohelp.com.br.

Tratamento dos dados pessoais

Após o encerramento, os dados pessoais que não precisem ser mantidos serão excluídos de forma segura, de acordo com a LGPD. Os registros cuja conservação seja exigida por lei permanecerão arquivados, com acesso restrito, pelo prazo previsto em nossa Política de Privacidade: ${PRIVACIDADE_URL}

Precisa falar conosco?

Os canais suporte@fisiohelp.com.br e privacidade@fisiohelp.com.br permanecerão disponíveis até 30 de dezembro de 2026.

Nosso agradecimento

Agradecemos a cada paciente e fisioterapeuta que confiou na FisioHelp e fez parte desta jornada. Foi uma honra trabalhar para aproximar profissionais e pessoas em busca de cuidado.

Com carinho,
Equipe FisioHelp

FisioHelp Intermediação de Negócios Tecnológicos Ltda.
CNPJ 67.039.614/0001-58`;

  return { assunto: ASSUNTO, corpoHtml, corpoTexto };
}

export default montarEmailComunicadoEncerramentoOperacao;
