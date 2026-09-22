import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ASSUNTO_LANCAMENTO = 'Novo benefício FisioHelp: descontos exclusivos na BCMED';
const ASSUNTO_LEMBRETE = 'Consulte seu benefício FisioHelp na BCMED';
const BENEFICIO_URL = 'https://compreno.link/FisioHelp';
const BCMED_URL = 'https://www.bcmed.com.br/fisioterapia';
const NOME_TOKEN = '{{NOME_FISIOTERAPEUTA}}';
const PREHEADER_TOKEN = '{{PREHEADER_CAMPANHA}}';
const ABERTURA_TOKEN = '{{ABERTURA_CAMPANHA}}';
const TEMPLATE_PATH = fileURLToPath(
  new URL('../templates/emails/beneficio-bcmed-fisioterapeuta.html', import.meta.url)
);

const TEXTOS = Object.freeze({
  lancamento: {
    assunto: ASSUNTO_LANCAMENTO,
    preheader:
      'Sua conta FisioHelp agora também dá acesso a condições especiais em equipamentos para Fisioterapia.',
    abertura: 'Temos uma novidade para quem faz parte da nossa comunidade.',
  },
  lembrete: {
    assunto: ASSUNTO_LEMBRETE,
    preheader:
      'Fisioterapeutas cadastrados na FisioHelp podem consultar condições especiais na BCMED.',
    abertura:
      'A parceria entre a FisioHelp e a BCMED oferece aos fisioterapeutas cadastrados condições especiais em equipamentos e produtos profissionais.',
  },
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

function normalizarNome(value) {
  return String(value ?? '').trim() || 'fisioterapeuta';
}

function normalizarVariacao(value) {
  return String(value ?? '').trim().toLowerCase() === 'lembrete'
    ? 'lembrete'
    : 'lancamento';
}

function carregarTemplateHtml() {
  if (templateHtmlCache !== null) return templateHtmlCache;

  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  for (const token of [NOME_TOKEN, PREHEADER_TOKEN, ABERTURA_TOKEN]) {
    if (!template.includes(token)) {
      throw new Error(`Template do benefício BCMED sem o marcador ${token}.`);
    }
  }

  if (!template.includes(BENEFICIO_URL) || !template.includes(BCMED_URL)) {
    throw new Error('Template do benefício BCMED sem os links oficiais esperados.');
  }

  templateHtmlCache = template;
  return templateHtmlCache;
}

function montarCorpoTexto(nome, variacao) {
  const textos = TEXTOS[variacao];
  return [
    textos.assunto,
    '',
    `Olá, ${nome}!`,
    '',
    textos.abertura,
    '',
    'Fisioterapeutas cadastrados na FisioHelp podem ter acesso a descontos e condições exclusivas em equipamentos e produtos profissionais.',
    '',
    'A BCMED possui equipamentos de eletroterapia, ultrassom, laser, acupuntura, móveis clínicos e outros recursos para a rotina do fisioterapeuta.',
    BCMED_URL,
    '',
    'Consultar benefício pelo WhatsApp:',
    BENEFICIO_URL,
    '',
    'O link abre uma conversa no WhatsApp com a equipe da BCMED e identifica que o contato veio pela FisioHelp.',
    '',
    'Queremos que a FisioHelp seja mais do que uma plataforma: queremos que ela gere valor para a sua rotina profissional.',
    '',
    'Obrigado por fazer parte da FisioHelp.',
    '',
    'Equipe FisioHelp',
    'Para quem precisa de cuidado. Para quem escolheu cuidar.',
    '',
    'Se não quiser mais receber comunicações sobre este benefício, escreva para suporte@fisiohelp.com.br com o assunto "Descadastrar benefício BCMED".',
  ].join('\n');
}

export function montarEmailBeneficioBcmedFisioterapeuta({
  nomeFisioterapeuta,
  variacao = 'lancamento',
} = {}) {
  const nome = normalizarNome(nomeFisioterapeuta);
  const variacaoNormalizada = normalizarVariacao(variacao);
  const textos = TEXTOS[variacaoNormalizada];
  const corpoHtml = carregarTemplateHtml()
    .replaceAll(NOME_TOKEN, escapeHtml(nome))
    .replaceAll(PREHEADER_TOKEN, escapeHtml(textos.preheader))
    .replaceAll(ABERTURA_TOKEN, escapeHtml(textos.abertura));

  return {
    assunto: textos.assunto,
    corpoHtml,
    corpoTexto: montarCorpoTexto(nome, variacaoNormalizada),
  };
}

export const BENEFICIO_BCMED_EMAIL_ASSUNTO_LANCAMENTO = ASSUNTO_LANCAMENTO;
export const BENEFICIO_BCMED_EMAIL_ASSUNTO_LEMBRETE = ASSUNTO_LEMBRETE;

export default {
  montarEmailBeneficioBcmedFisioterapeuta,
  BENEFICIO_BCMED_EMAIL_ASSUNTO_LANCAMENTO,
  BENEFICIO_BCMED_EMAIL_ASSUNTO_LEMBRETE,
};
