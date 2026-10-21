import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ASSUNTO = 'Sua conta está pronta. Que tal encontrar seu fisioterapeuta?';
const TEMPLATE_PATH = fileURLToPath(
  new URL('../templates/emails/ativacao-primeira-consulta-paciente.html', import.meta.url)
);
const TOKENS = Object.freeze({
  assunto: '{{ASSUNTO_CAMPANHA}}',
  saudacao: '{{SAUDACAO_PACIENTE}}',
  fisioterapeutasUrl: '{{URL_FISIOTERAPEUTAS}}',
  videoUrl: '{{URL_VIDEO}}',
  videoThumbnailUrl: '{{URL_VIDEO_THUMBNAIL}}',
  appStoreUrl: '{{URL_APP_STORE}}',
  googlePlayUrl: '{{URL_GOOGLE_PLAY}}',
});

const DEFAULTS = Object.freeze({
  fisioterapeutasUrl:
    'https://fisiohelp.com.br/fisioterapeutas?utm_source=email&utm_medium=crm&utm_campaign=ativacao_primeira_consulta',
  videoUrl: 'https://www.youtube.com/shorts/p7bcIv3_qJ4',
  videoThumbnailUrl: 'https://img.youtube.com/vi/p7bcIv3_qJ4/maxresdefault.jpg',
  appStoreUrl: 'https://apps.apple.com/br/app/fisiohelp/id6794336661',
  googlePlayUrl: 'https://play.google.com/store/apps/details?id=br.com.fisiohelp.app',
});

const URL_RULES = Object.freeze({
  fisioterapeutasUrl: ['fisiohelp.com.br', 'www.fisiohelp.com.br'],
  videoUrl: ['youtube.com', 'www.youtube.com', 'youtu.be'],
  videoThumbnailUrl: ['img.youtube.com', 'i.ytimg.com'],
  appStoreUrl: ['apps.apple.com'],
  googlePlayUrl: ['play.google.com'],
});

let templateHtmlCache = null;

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

function normalizarUrl(value, key) {
  const parsed = new URL(String(value || DEFAULTS[key]).trim());
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !URL_RULES[key].includes(parsed.hostname.toLowerCase())
  ) {
    throw new Error(`URL inválida no e-mail de ativação: ${key}.`);
  }
  return parsed.toString();
}

function carregarTemplateHtml() {
  if (templateHtmlCache !== null) return templateHtmlCache;
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  for (const token of Object.values(TOKENS)) {
    if (!template.includes(token)) {
      throw new Error(`Template de ativação do paciente sem o marcador ${token}.`);
    }
  }
  templateHtmlCache = template;
  return templateHtmlCache;
}

function montarSaudacaoHtml(nomePaciente) {
  const nome = primeiroNome(nomePaciente);
  return nome ? `Olá, <strong>${escapeHtml(nome)}</strong>!` : 'Olá!';
}

function montarSaudacaoTexto(nomePaciente) {
  const nome = primeiroNome(nomePaciente);
  return nome ? `Olá, ${nome}!` : 'Olá!';
}

function montarCorpoTexto(nomePaciente, urls) {
  return [
    'Sua fisioterapia pode começar por aqui.',
    '',
    montarSaudacaoTexto(nomePaciente),
    '',
    'Você já criou sua conta na FisioHelp. Agora, falta apenas escolher o fisioterapeuta, encontrar um horário que funcione para você e fazer o agendamento.',
    '',
    'Você pode começar pelo site ou pelo app. Sua conta FisioHelp é a mesma nos dois.',
    '',
    'Como agendar:',
    '1. Acesse a busca de fisioterapeutas no site ou toque em Buscar no app.',
    '2. Escolha o fisioterapeuta.',
    '3. Selecione a data e o horário.',
    '4. Toque em Agendar.',
    '5. Leia e aceite o sumário do contrato.',
    '6. Escolha a forma de pagamento.',
    '7. Preencha os dados necessários para pagar.',
    '8. Acompanhe a confirmação da consulta pela FisioHelp.',
    '',
    `Encontrar um fisioterapeuta: ${urls.fisioterapeutasUrl}`,
    `Assistir ao tutorial: ${urls.videoUrl}`,
    `Baixar na App Store: ${urls.appStoreUrl}`,
    `Baixar no Google Play: ${urls.googlePlayUrl}`,
    '',
    'Esperamos facilitar seu caminho até o cuidado que você procura.',
    '',
    'Equipe FisioHelp',
    'Para quem precisa de cuidado. Para quem escolheu cuidar.',
    '',
    'FisioHelp Intermediação de Negócios Tecnológicos Ltda. — CNPJ 67.039.614/0001-58',
    'Se não quiser receber comunicações de ativação como esta, escreva para suporte@fisiohelp.com.br com o assunto "Descadastrar comunicações de ativação".',
  ].join('\n');
}

export function montarEmailPacientePrimeiraConsulta({
  nomePaciente,
  fisioterapeutasUrl = DEFAULTS.fisioterapeutasUrl,
  videoUrl = DEFAULTS.videoUrl,
  videoThumbnailUrl = DEFAULTS.videoThumbnailUrl,
  appStoreUrl = DEFAULTS.appStoreUrl,
  googlePlayUrl = DEFAULTS.googlePlayUrl,
} = {}) {
  const urls = {
    fisioterapeutasUrl: normalizarUrl(fisioterapeutasUrl, 'fisioterapeutasUrl'),
    videoUrl: normalizarUrl(videoUrl, 'videoUrl'),
    videoThumbnailUrl: normalizarUrl(videoThumbnailUrl, 'videoThumbnailUrl'),
    appStoreUrl: normalizarUrl(appStoreUrl, 'appStoreUrl'),
    googlePlayUrl: normalizarUrl(googlePlayUrl, 'googlePlayUrl'),
  };

  const replacements = new Map([
    [TOKENS.assunto, escapeHtml(ASSUNTO)],
    [TOKENS.saudacao, montarSaudacaoHtml(nomePaciente)],
    [TOKENS.fisioterapeutasUrl, escapeHtml(urls.fisioterapeutasUrl)],
    [TOKENS.videoUrl, escapeHtml(urls.videoUrl)],
    [TOKENS.videoThumbnailUrl, escapeHtml(urls.videoThumbnailUrl)],
    [TOKENS.appStoreUrl, escapeHtml(urls.appStoreUrl)],
    [TOKENS.googlePlayUrl, escapeHtml(urls.googlePlayUrl)],
  ]);

  let corpoHtml = carregarTemplateHtml();
  for (const [token, value] of replacements) {
    corpoHtml = corpoHtml.replaceAll(token, value);
  }

  if (/\{\{[^}]+\}\}/.test(corpoHtml)) {
    throw new Error('Template de ativação do paciente contém marcador residual.');
  }

  return {
    assunto: ASSUNTO,
    corpoHtml,
    corpoTexto: montarCorpoTexto(nomePaciente, urls),
  };
}

export const PACIENTE_PRIMEIRA_CONSULTA_EMAIL_ASSUNTO = ASSUNTO;

export default {
  montarEmailPacientePrimeiraConsulta,
  PACIENTE_PRIMEIRA_CONSULTA_EMAIL_ASSUNTO,
};
