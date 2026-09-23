import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ASSUNTO_LANCAMENTO = '🧡 Novo benefício FisioHelp: 10% OFF na Jalecos Conforto';
const ASSUNTO_LEMBRETE = 'Seu cupom de 10% OFF na Jalecos Conforto';
const DEFAULT_BENEFICIO_URL = 'https://www.jalecosconforto.com.br/';
const DEFAULT_CUPOM = 'FisioHelp';
const ASSUNTO_TOKEN = '{{ASSUNTO_CAMPANHA}}';
const NOME_TOKEN = '{{NOME_FISIOTERAPEUTA}}';
const PREHEADER_TOKEN = '{{PREHEADER_CAMPANHA}}';
const ABERTURA_TOKEN = '{{ABERTURA_CAMPANHA}}';
const URL_TOKEN = '{{URL_BENEFICIO}}';
const CUPOM_TOKEN = '{{CUPOM_BENEFICIO}}';
const TEMPLATE_PATH = fileURLToPath(
  new URL('../templates/emails/beneficio-jalecos-conforto-fisioterapeuta.html', import.meta.url)
);

const TEXTOS = Object.freeze({
  lancamento: {
    assunto: ASSUNTO_LANCAMENTO,
    preheader:
      'Seu cadastro na FisioHelp agora também dá acesso a uma nova vantagem para sua rotina profissional.',
    abertura: 'Temos mais uma novidade para quem faz parte da FisioHelp.',
  },
  lembrete: {
    assunto: ASSUNTO_LEMBRETE,
    preheader:
      'Use o cupom FisioHelp e aproveite 10% OFF em jalecos e scrubs profissionais.',
    abertura:
      'A parceria entre a FisioHelp e a Jalecos Conforto oferece 10% de desconto para fisioterapeutas cadastrados.',
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

function normalizarUrl(value) {
  const parsed = new URL(String(value || DEFAULT_BENEFICIO_URL).trim());
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !['jalecosconforto.com.br', 'www.jalecosconforto.com.br'].includes(
      parsed.hostname.toLowerCase()
    )
  ) {
    throw new Error('URL do benefício Jalecos Conforto inválida.');
  }
  return parsed.toString();
}

function normalizarCupom(value) {
  const cupom = String(value || DEFAULT_CUPOM).trim();
  if (!/^[A-Za-z0-9_-]{3,30}$/.test(cupom)) {
    throw new Error('Cupom do benefício Jalecos Conforto inválido.');
  }
  return cupom;
}

function carregarTemplateHtml() {
  if (templateHtmlCache !== null) return templateHtmlCache;

  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  for (const token of [
    ASSUNTO_TOKEN,
    NOME_TOKEN,
    PREHEADER_TOKEN,
    ABERTURA_TOKEN,
    URL_TOKEN,
    CUPOM_TOKEN,
  ]) {
    if (!template.includes(token)) {
      throw new Error(`Template do benefício Jalecos Conforto sem o marcador ${token}.`);
    }
  }
  if (template.includes('Protótipo visual')) {
    throw new Error('Template de produção contém comentário de protótipo.');
  }

  templateHtmlCache = template;
  return templateHtmlCache;
}

function montarCorpoTexto(nome, variacao, beneficioUrl, cupom) {
  const textos = TEXTOS[variacao];
  return [
    textos.assunto,
    '',
    `Olá, ${nome}!`,
    '',
    textos.abertura,
    '',
    'A FisioHelp agora é parceira da Jalecos Conforto.',
    'Fisioterapeutas cadastrados têm 10% de desconto em todo o site.',
    '',
    `Cupom: ${cupom}`,
    '',
    'Acesse a loja:',
    beneficioUrl,
    '',
    'Escolha seus jalecos ou scrubs e informe o cupom no momento da compra.',
    '',
    'Fazer parte da FisioHelp é ter cada vez mais benefícios.',
    '',
    'Abraço,',
    'Equipe FisioHelp',
    '',
    'Se não quiser mais receber comunicações sobre este benefício, escreva para suporte@fisiohelp.com.br com o assunto "Descadastrar benefício Jalecos Conforto".',
  ].join('\n');
}

export function montarEmailBeneficioJalecosConfortoFisioterapeuta({
  nomeFisioterapeuta,
  variacao = 'lancamento',
  beneficioUrl = DEFAULT_BENEFICIO_URL,
  cupom = DEFAULT_CUPOM,
} = {}) {
  const nome = normalizarNome(nomeFisioterapeuta);
  const variacaoNormalizada = normalizarVariacao(variacao);
  const textos = TEXTOS[variacaoNormalizada];
  const url = normalizarUrl(beneficioUrl);
  const cupomNormalizado = normalizarCupom(cupom);
  const corpoHtml = carregarTemplateHtml()
    .replaceAll(ASSUNTO_TOKEN, escapeHtml(textos.assunto))
    .replaceAll(NOME_TOKEN, escapeHtml(nome))
    .replaceAll(PREHEADER_TOKEN, escapeHtml(textos.preheader))
    .replaceAll(ABERTURA_TOKEN, escapeHtml(textos.abertura))
    .replaceAll(URL_TOKEN, escapeHtml(url))
    .replaceAll(CUPOM_TOKEN, escapeHtml(cupomNormalizado));

  return {
    assunto: textos.assunto,
    corpoHtml,
    corpoTexto: montarCorpoTexto(nome, variacaoNormalizada, url, cupomNormalizado),
  };
}

export const BENEFICIO_JALECOS_CONFORTO_EMAIL_ASSUNTO_LANCAMENTO = ASSUNTO_LANCAMENTO;
export const BENEFICIO_JALECOS_CONFORTO_EMAIL_ASSUNTO_LEMBRETE = ASSUNTO_LEMBRETE;

export default {
  montarEmailBeneficioJalecosConfortoFisioterapeuta,
  BENEFICIO_JALECOS_CONFORTO_EMAIL_ASSUNTO_LANCAMENTO,
  BENEFICIO_JALECOS_CONFORTO_EMAIL_ASSUNTO_LEMBRETE,
};
