import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ASSUNTO = 'Seu perfil na FisioHelp está completo?';
const NOME_TOKEN = '{{NOME_FISIOTERAPEUTA}}';
const TEMPLATE_PATH = fileURLToPath(
  new URL('../templates/emails/lembrete-perfil-fisioterapeuta.html', import.meta.url)
);

let templateHtmlCache = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizarNome(value) {
  return String(value ?? '').trim() || 'fisioterapeuta';
}

function carregarTemplateHtml() {
  if (templateHtmlCache !== null) return templateHtmlCache;

  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  if (!template.includes(NOME_TOKEN)) {
    throw new Error('Template de lembrete de perfil sem o marcador ' + NOME_TOKEN + '.');
  }

  templateHtmlCache = template;
  return templateHtmlCache;
}

function montarCorpoTexto(nome) {
  return [
    ASSUNTO,
    '',
    'Olá, ' + nome + '! Tudo bem?',
    '',
    'Seu perfil é a sua apresentação para os pacientes dentro da FisioHelp.',
    '',
    'Quanto mais completas e atualizadas estiverem as suas informações, mais fácil será para os pacientes conhecerem o seu trabalho, entenderem suas especialidades e encontrarem um atendimento alinhado ao que procuram.',
    '',
    'Revise seus dados de contato, foto profissional, descrição, vídeo de apresentação, disponibilidade de agenda, formações acadêmicas e dados bancários.',
    '',
    'Abra o app FisioHelp e complete ou atualize as informações do seu perfil.',
    '',
    'Obrigado por fazer parte da FisioHelp.',
    '',
    'Equipe FisioHelp',
    'Para quem precisa de cuidado. Para quem escolheu cuidar.',
    '',
    'Mensagem automática — esta caixa não é monitorada. Fale com suporte@fisiohelp.com.br.',
    '',
    'Siga a FisioHelp nas redes sociais:',
    'LinkedIn: https://www.linkedin.com/company/fisiohelpbr/',
    'Instagram: https://www.instagram.com/fisiohelp.br?utm_source=qr',
  ].join('\n');
}

export function montarEmailLembretePerfilFisioterapeuta({ nomeFisioterapeuta } = {}) {
  const nome = normalizarNome(nomeFisioterapeuta);
  const corpoHtml = carregarTemplateHtml().replaceAll(NOME_TOKEN, escapeHtml(nome));

  return {
    assunto: ASSUNTO,
    corpoHtml,
    corpoTexto: montarCorpoTexto(nome),
  };
}

export const PERFIL_FISIOTERAPEUTA_EMAIL_ASSUNTO = ASSUNTO;

export default {
  montarEmailLembretePerfilFisioterapeuta,
  PERFIL_FISIOTERAPEUTA_EMAIL_ASSUNTO,
};