import { escapeHtml, montarShell } from './emailTemplates.js';

function texto(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function primeiroNome(value, fallback = 'usuario') {
  return texto(value, fallback).split(/\s+/)[0] || fallback;
}

function formatarExpiracao(minutos) {
  const n = Number(minutos);
  if (!Number.isFinite(n) || n <= 0) return '10 minutos';
  if (n % 1440 === 0) {
    const dias = n / 1440;
    return dias === 1 ? '24 horas' : `${dias * 24} horas`;
  }
  if (n % 60 === 0) {
    const horas = n / 60;
    return horas === 1 ? '1 hora' : `${horas} horas`;
  }
  return n === 1 ? '1 minuto' : `${n} minutos`;
}

function paragrafoHtml(conteudo) {
  return `<p style="margin:0 0 16px 0;color:#3D2B22;font-size:16px;line-height:1.6;">${escapeHtml(conteudo)}</p>`;
}

function blocoCodigoHtml(rotulo, codigo) {
  return `
    <div style="margin:24px 0;padding:18px;border-radius:8px;background:#FDF4E0;border:1px solid rgba(61,43,34,0.12);text-align:center;">
      <div style="margin:0 0 8px 0;color:#6f5a4c;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(rotulo)}</div>
      <div style="color:#3D2B22;font-size:30px;line-height:1.2;font-weight:700;letter-spacing:.18em;">${escapeHtml(codigo)}</div>
    </div>`;
}

export function montarEmailVerificacaoPaciente({ nome, codigo, expiraEmMinutos = 10 } = {}) {
  const nomePaciente = primeiroNome(nome, 'Paciente');
  const expiracao = formatarExpiracao(expiraEmMinutos);
  const assunto = 'Confirme seu e-mail para ativar sua conta na FisioHelp';

  const conteudoHtml = `
    <h1 style="margin:0 0 18px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">${escapeHtml(assunto)}</h1>
    ${paragrafoHtml(`Olá, ${nomePaciente},`)}
    ${paragrafoHtml('Bem-vindo à FisioHelp.')}
    ${paragrafoHtml('Recebemos seu cadastro como paciente. Para proteger sua conta e garantir que você receba informações importantes sobre consultas, pagamentos, cancelamentos e suporte, confirme seu e-mail usando o código abaixo:')}
    ${blocoCodigoHtml('Código de verificação', codigo)}
    ${paragrafoHtml('No app FisioHelp, acesse Minha Conta > Verificação de contato, toque em "Verificar agora" no e-mail e digite este código.')}
    ${paragrafoHtml(`Este código expira em ${expiracao}.`)}
    ${paragrafoHtml('Se você não criou uma conta na FisioHelp, ignore esta mensagem ou entre em contato pelo e-mail suporte@fisiohelp.com.br.')}
    ${paragrafoHtml('Atenciosamente,')}
    ${paragrafoHtml('Equipe FisioHelp')}`;

  const conteudoTexto = `Olá, ${nomePaciente},

Bem-vindo à FisioHelp.

Recebemos seu cadastro como paciente. Para proteger sua conta e garantir que você receba informações importantes sobre consultas, pagamentos, cancelamentos e suporte, confirme seu e-mail usando o código abaixo:

Código de verificação: ${codigo}

No app FisioHelp, acesse Minha Conta > Verificação de contato, toque em "Verificar agora" no e-mail e digite este código.

Este código expira em ${expiracao}.

Se você não criou uma conta na FisioHelp, ignore esta mensagem ou entre em contato pelo e-mail suporte@fisiohelp.com.br.

Atenciosamente,
Equipe FisioHelp`;

  return montarShell({ assunto, conteudoHtml, conteudoTexto });
}

export function montarEmailVerificacaoFisioterapeuta({ nome, codigo, expiraEmMinutos = 10 } = {}) {
  const nomeFisioterapeuta = primeiroNome(nome, 'Fisioterapeuta');
  const expiracao = formatarExpiracao(expiraEmMinutos);
  const assunto = 'Confirme seu e-mail para continuar seu cadastro na FisioHelp';

  const conteudoHtml = `
    <h1 style="margin:0 0 18px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">${escapeHtml(assunto)}</h1>
    ${paragrafoHtml(`Olá, ${nomeFisioterapeuta},`)}
    ${paragrafoHtml('Bem-vindo à FisioHelp.')}
    ${paragrafoHtml('Recebemos seu cadastro como fisioterapeuta. Para proteger sua conta e garantir que você receba informações importantes sobre agenda, pacientes, pagamentos, repasses e validação cadastral, confirme seu e-mail usando o código abaixo:')}
    ${blocoCodigoHtml('Código de verificação', codigo)}
    ${paragrafoHtml('No app FisioHelp, acesse Minha Conta > Verificação de contato, toque em "Verificar agora" no e-mail e digite este código.')}
    ${paragrafoHtml(`Este código expira em ${expiracao}.`)}
    ${paragrafoHtml('Importante: a confirmação do e-mail não conclui automaticamente a liberação do seu perfil. Seu registro profissional e seus dados cadastrais ainda poderão passar pela validação da FisioHelp.')}
    ${paragrafoHtml('Se você não criou uma conta na FisioHelp, ignore esta mensagem ou entre em contato pelo e-mail suporte@fisiohelp.com.br.')}
    ${paragrafoHtml('Atenciosamente,')}
    ${paragrafoHtml('Equipe FisioHelp')}`;

  const conteudoTexto = `Olá, ${nomeFisioterapeuta},

Bem-vindo à FisioHelp.

Recebemos seu cadastro como fisioterapeuta. Para proteger sua conta e garantir que você receba informações importantes sobre agenda, pacientes, pagamentos, repasses e validação cadastral, confirme seu e-mail usando o código abaixo:

Código de verificação: ${codigo}

No app FisioHelp, acesse Minha Conta > Verificação de contato, toque em "Verificar agora" no e-mail e digite este código.

Este código expira em ${expiracao}.

Importante: a confirmação do e-mail não conclui automaticamente a liberação do seu perfil. Seu registro profissional e seus dados cadastrais ainda poderão passar pela validação da FisioHelp.

Se você não criou uma conta na FisioHelp, ignore esta mensagem ou entre em contato pelo e-mail suporte@fisiohelp.com.br.

Atenciosamente,
Equipe FisioHelp`;

  return montarShell({ assunto, conteudoHtml, conteudoTexto });
}

export function montarEmailConvitePreCadastroSimples({
  nomePaciente,
  nomeFisioterapeuta,
} = {}) {
  const paciente = primeiroNome(nomePaciente, 'Paciente');
  const fisio = texto(nomeFisioterapeuta, 'Seu fisioterapeuta');
  const assunto = `${fisio} convidou você para acessar a FisioHelp`.slice(0, 200);

  const conteudoHtml = `
    <h1 style="margin:0 0 18px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">${escapeHtml(assunto)}</h1>
    ${paragrafoHtml(`Olá, ${paciente},`)}
    ${paragrafoHtml(`${fisio} iniciou seu pré-cadastro na FisioHelp para facilitar seu acompanhamento e o agendamento de atendimentos pela plataforma.`)}
    ${paragrafoHtml('Para acessar, abra o app FisioHelp, toque em "Cadastre-se" e escolha "Já fui pré-cadastrado por um fisioterapeuta". Informe seu CPF e e-mail para criar sua senha.')}
    ${paragrafoHtml('Depois de ativar sua conta, você poderá completar seus dados, acessar sua área no aplicativo e acompanhar consultas, mensagens e notificações relacionadas aos seus atendimentos.')}
    ${paragrafoHtml('Se você não reconhece este convite ou acredita que recebeu esta mensagem por engano, ignore este e-mail ou entre em contato pelo e-mail suporte@fisiohelp.com.br.')}
    ${paragrafoHtml('Atenciosamente,')}
    ${paragrafoHtml('Equipe FisioHelp')}`;

  const conteudoTexto = `Olá, ${paciente},

${fisio} iniciou seu pré-cadastro na FisioHelp para facilitar seu acompanhamento e o agendamento de atendimentos pela plataforma.

Para acessar, abra o app FisioHelp, toque em "Cadastre-se" e escolha "Já fui pré-cadastrado por um fisioterapeuta". Informe seu CPF e e-mail para criar sua senha.

Depois de ativar sua conta, você poderá completar seus dados, acessar sua área no aplicativo e acompanhar consultas, mensagens e notificações relacionadas aos seus atendimentos.

Se você não reconhece este convite ou acredita que recebeu esta mensagem por engano, ignore este e-mail ou entre em contato pelo e-mail suporte@fisiohelp.com.br.

Atenciosamente,
Equipe FisioHelp`;

  return montarShell({ assunto, conteudoHtml, conteudoTexto });
}

export function montarEmailRedefinicaoSenha({ nome, codigo, expiraEmMinutos = 10 } = {}) {
  const nomeUsuario = primeiroNome(nome, 'usuario');
  const expiracao = formatarExpiracao(expiraEmMinutos);
  const assunto = 'Código para redefinir sua senha na FisioHelp';

  const conteudoHtml = `
    <h1 style="margin:0 0 18px 0;color:#3D2B22;font-size:22px;line-height:1.3;font-weight:700;">${escapeHtml(assunto)}</h1>
    ${paragrafoHtml(`Olá, ${nomeUsuario},`)}
    ${paragrafoHtml('Recebemos uma solicitação para redefinir a senha da sua conta FisioHelp.')}
    ${paragrafoHtml('Use o código abaixo no app para criar uma nova senha:')}
    ${blocoCodigoHtml('Código de redefinição', codigo)}
    ${paragrafoHtml(`Este código expira em ${expiracao}.`)}
    ${paragrafoHtml('No app FisioHelp, na tela de login, toque em "Esqueceu a senha?", informe seu e-mail e digite este código para criar uma nova senha.')}
    ${paragrafoHtml('Se você não solicitou a redefinição de senha, ignore esta mensagem ou entre em contato pelo e-mail suporte@fisiohelp.com.br.')}
    ${paragrafoHtml('Atenciosamente,')}
    ${paragrafoHtml('Equipe FisioHelp')}`;

  const conteudoTexto = `Olá, ${nomeUsuario},

Recebemos uma solicitação para redefinir a senha da sua conta FisioHelp.

Use o código abaixo no app para criar uma nova senha:

Código de redefinição: ${codigo}

Este código expira em ${expiracao}.

No app FisioHelp, na tela de login, toque em "Esqueceu a senha?", informe seu e-mail e digite este código para criar uma nova senha.

Se você não solicitou a redefinição de senha, ignore esta mensagem ou entre em contato pelo e-mail suporte@fisiohelp.com.br.

Atenciosamente,
Equipe FisioHelp`;

  return montarShell({ assunto, conteudoHtml, conteudoTexto });
}

export default {
  montarEmailVerificacaoPaciente,
  montarEmailVerificacaoFisioterapeuta,
  montarEmailConvitePreCadastroSimples,
  montarEmailRedefinicaoSenha,
};
