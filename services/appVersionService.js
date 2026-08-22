import { HttpError } from '../utils/httpError.js';

const VERSION_RE = /^\d+(?:\.\d+){1,3}$/;

function normalizarVersao(value, campo) {
  const versao = String(value || '').trim();
  if (!VERSION_RE.test(versao)) {
    throw new HttpError(400, `${campo} inválida. Use formato numérico como 1.0.3.`);
  }
  return versao;
}

function normalizarBuild(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 0;
  const build = Number(value);
  if (!Number.isInteger(build) || build < 0) {
    throw new HttpError(400, 'Build inválido. Use um inteiro maior ou igual a zero.');
  }
  return build;
}

export function compararVersoes(left, right) {
  const esquerda = normalizarVersao(left, 'Versão atual')
    .split('.')
    .map(Number);
  const direita = normalizarVersao(right, 'Versão mínima')
    .split('.')
    .map(Number);
  const tamanho = Math.max(esquerda.length, direita.length);

  for (let index = 0; index < tamanho; index += 1) {
    const atual = esquerda[index] || 0;
    const minima = direita[index] || 0;
    if (atual < minima) return -1;
    if (atual > minima) return 1;
  }

  return 0;
}

function obterConfiguracao(plataforma, env) {
  if (plataforma === 'android') {
    return {
      modo: env.MOBILE_ANDROID_UPDATE_MODE,
      versaoMinima: env.MOBILE_ANDROID_MIN_VERSION,
      buildMinimo: env.MOBILE_ANDROID_MIN_BUILD,
      lojaUrl: env.MOBILE_ANDROID_STORE_URL,
    };
  }

  return {
    modo: env.MOBILE_IOS_UPDATE_MODE,
    versaoMinima: env.MOBILE_IOS_MIN_VERSION,
    buildMinimo: env.MOBILE_IOS_MIN_BUILD,
    lojaUrl: env.MOBILE_IOS_STORE_URL,
  };
}

export function obterStatusVersaoApp(
  { plataforma: plataformaRaw, versao: versaoRaw, build: buildRaw },
  env
) {
  const plataforma = String(plataformaRaw || '').trim().toLowerCase();
  if (!['android', 'ios'].includes(plataforma)) {
    throw new HttpError(400, 'Plataforma inválida. Use android ou ios.');
  }

  const versaoAtual = normalizarVersao(versaoRaw, 'Versão atual');
  const buildAtual = normalizarBuild(buildRaw);
  if (!env) {
    throw new HttpError(500, 'Configuração de versão do aplicativo ausente.');
  }

  const config = obterConfiguracao(plataforma, env);
  const comparacao = compararVersoes(versaoAtual, config.versaoMinima);
  const versaoInferior = comparacao < 0;
  const buildInferior =
    comparacao === 0 &&
    Number(config.buildMinimo) > 0 &&
    buildAtual < Number(config.buildMinimo);
  const atualizacaoObrigatoria =
    config.modo === 'required' && (versaoInferior || buildInferior);

  return {
    plataforma,
    versaoAtual,
    buildAtual,
    versaoMinima: config.versaoMinima,
    buildMinimo: Number(config.buildMinimo) || 0,
    atualizacaoObrigatoria,
    titulo: 'Atualização necessária',
    mensagem: atualizacaoObrigatoria
      ? 'Atualize a FisioHelp para continuar acessando normalmente.'
      : 'Seu aplicativo está atualizado.',
    lojaUrl: config.lojaUrl,
  };
}

export default { obterStatusVersaoApp };
