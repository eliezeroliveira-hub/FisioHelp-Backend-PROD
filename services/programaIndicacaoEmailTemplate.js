import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ASSUNTO_LANCAMENTO = 'Programa de Indicação FisioHelp: ganhe até R$ 40 por indicação aprovada';
const ASSUNTO_MENSAL = 'As faixas recomeçaram: indique e ganhe neste mês';
const FORMULARIO_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSfPkpj4Bet5Tbo1snMD2A7hnp5OvgXWeycqvRERyeO5oGdRQw/viewform?usp=publish-editor';
const TERMOS_URL = 'https://drive.google.com/file/d/18j7IauYdmblWMsJfbFvR3jk6dSi_1DUC/view?usp=sharing';
const NOME_TOKEN = '{{NOME_FISIOTERAPEUTA}}';
const PREHEADER_TOKEN = '{{PREHEADER_CAMPANHA}}';
const ABERTURA_TOKEN = '{{ABERTURA_CAMPANHA}}';
const IMAGEM_CONTENT_ID = 'fisiohelp_programa_indicacao';
const TEMPLATE_PATH = fileURLToPath(
  new URL('../templates/emails/programa-indicacao-fisioterapeuta.html', import.meta.url)
);
const IMAGEM_PATH = fileURLToPath(
  new URL('../templates/emails/assets/programa-indicacao-iphone.png', import.meta.url)
);

const TEXTOS = Object.freeze({
  lancamento: {
    assunto: ASSUNTO_LANCAMENTO,
    preheader: 'Indique fisioterapeutas e ganhe até R$ 40 por indicação aprovada.',
    abertura:
      'Compartilhe seu código de indicação com outros fisioterapeutas. Quando um profissional indicado por você concluir o cadastro e tiver o CREFITO aprovado pela FisioHelp, a indicação se torna elegível para recompensa.',
  },
  mensal: {
    assunto: ASSUNTO_MENSAL,
    preheader: 'As faixas voltaram a zero. É hora de indicar novamente e ganhar.',
    abertura:
      'As faixas voltaram a zero com o início do novo mês. É hora de indicar novamente: compartilhe seu código com outros fisioterapeutas e acompanhe as novas aprovações.',
  },
});

let templateHtmlCache = null;
let imagemBase64Cache = null;

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
  return String(value ?? '').trim().toLowerCase() === 'mensal' ? 'mensal' : 'lancamento';
}

function carregarTemplateHtml() {
  if (templateHtmlCache !== null) return templateHtmlCache;

  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  for (const token of [NOME_TOKEN, PREHEADER_TOKEN, ABERTURA_TOKEN]) {
    if (!template.includes(token)) {
      throw new Error(`Template do Programa de Indicação sem o marcador ${token}.`);
    }
  }

  if (!template.includes(`cid:${IMAGEM_CONTENT_ID}`)) {
    throw new Error('Template do Programa de Indicação sem a imagem inline esperada.');
  }

  templateHtmlCache = template;
  return templateHtmlCache;
}

function carregarImagemBase64() {
  if (imagemBase64Cache === null) {
    imagemBase64Cache = readFileSync(IMAGEM_PATH).toString('base64');
  }
  return imagemBase64Cache;
}

function montarCorpoTexto(nome, variacao) {
  const textos = TEXTOS[variacao];

  return [
    textos.assunto,
    '',
    `Olá, ${nome}! 🧡`,
    '',
    textos.abertura,
    '',
    'Para participar, preencha o formulário e confirme a leitura e o aceite dos Termos do Programa:',
    FORMULARIO_URL,
    '',
    'Quanto você pode ganhar:',
    '- 1ª à 5ª aprovação: R$ 20 por indicação',
    '- 6ª à 10ª aprovação: R$ 30 por indicação',
    '- A partir da 11ª aprovação: R$ 40 por indicação',
    '',
    'As faixas são progressivas e não retroativas: cada indicação recebe o valor correspondente à faixa em que foi aprovada, considerando a quantidade acumulada no mesmo mês.',
    '',
    'Exemplos no mesmo mês:',
    '- 5 aprovações: R$ 100',
    '- 10 aprovações: R$ 250',
    '- 12 aprovações: R$ 330',
    '',
    'Onde encontro meu código?',
    'No app, abra Perfil, selecione Indicações e toque em Copiar ao lado do seu código.',
    '',
    'A apuração acontece do primeiro ao último dia de cada mês e reinicia no mês seguinte. Vale o mês em que a indicação for efetivamente aprovada.',
    '',
    'O pagamento é realizado até o 10º dia útil do mês seguinte, diretamente na conta de recebimento cadastrada no app.',
    '',
    'Termos completos:',
    TERMOS_URL,
    '',
    'Equipe FisioHelp',
    'Para quem precisa de cuidado. Para quem escolheu cuidar.',
    'suporte@fisiohelp.com.br',
  ].join('\n');
}

export function montarEmailProgramaIndicacaoFisioterapeuta({
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
    anexos: [
      {
        name: 'programa-indicacao-fisiohelp.png',
        contentType: 'image/png',
        contentInBase64: carregarImagemBase64(),
        contentId: IMAGEM_CONTENT_ID,
      },
    ],
  };
}

export const PROGRAMA_INDICACAO_EMAIL_ASSUNTO_LANCAMENTO = ASSUNTO_LANCAMENTO;
export const PROGRAMA_INDICACAO_EMAIL_ASSUNTO_MENSAL = ASSUNTO_MENSAL;

export default {
  montarEmailProgramaIndicacaoFisioterapeuta,
  PROGRAMA_INDICACAO_EMAIL_ASSUNTO_LANCAMENTO,
  PROGRAMA_INDICACAO_EMAIL_ASSUNTO_MENSAL,
};