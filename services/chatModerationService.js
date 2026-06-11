const CONTACT_BLOCK_MESSAGE =
  'Mensagem bloqueada: não é permitido compartilhar links ou dados pessoais (telefone, e-mail, CPF/CNPJ, Pix).';

const OFFENSIVE_BLOCK_MESSAGE =
  'Mensagem bloqueada: não é permitido enviar ofensas, ameaças ou discriminação no chat.';

function normalizeForModeration(value) {
  const raw = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const leet = raw
    .replace(/[@4]/g, 'a')
    .replace(/3/g, 'e')
    .replace(/[1!]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/5/g, 's')
    .replace(/7/g, 't');

  return leet
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(text, pattern) {
  const match = String(text || '').match(pattern);
  return match?.[0] ? String(match[0]).slice(0, 200) : null;
}

function detectPersonalData(text) {
  const conteudo = String(text || '');
  const trimmed = conteudo.trim();
  const lower = conteudo.toLowerCase();
  const digitsOnly = conteudo.replace(/\D/g, '');

  const linkPattern = /(https?:\/\/|www\.|wa\.me\/|t\.me\/|bit\.ly\/|tinyurl\.com\/|instagram\.com\/|facebook\.com\/|linktr\.ee\/)/i;
  const emailPattern = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
  const phoneBrPattern = /(\+?55\s*)?(\(?\d{2}\)?\s*)?(9?\d{4})[-\s.]?\d{4}\b/i;
  const manyDigitsPattern = /(?:\d[\s().-]?){10,14}\d/;
  const cpfPattern = /\b\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[.\s-]?\d{2}\b/;
  const cnpjPattern = /\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[\s-]?\d{2}\b/;

  if (linkPattern.test(conteudo)) {
    return {
      blocked: true,
      motivo: 'LinkDetectado',
      trechoDetectado: firstMatch(conteudo, linkPattern),
      mensagemUsuario: CONTACT_BLOCK_MESSAGE,
    };
  }

  if (emailPattern.test(conteudo)) {
    return {
      blocked: true,
      motivo: 'EmailDetectado',
      trechoDetectado: firstMatch(conteudo, emailPattern),
      mensagemUsuario: CONTACT_BLOCK_MESSAGE,
    };
  }

  if (phoneBrPattern.test(conteudo) || manyDigitsPattern.test(conteudo)) {
    return {
      blocked: true,
      motivo: 'TelefoneDetectado',
      trechoDetectado:
        firstMatch(conteudo, phoneBrPattern) ||
        firstMatch(conteudo, manyDigitsPattern) ||
        trimmed.slice(0, 200),
      mensagemUsuario: CONTACT_BLOCK_MESSAGE,
    };
  }

  if (cpfPattern.test(conteudo) || cnpjPattern.test(conteudo)) {
    return {
      blocked: true,
      motivo: 'DadoBancarioDetectado',
      trechoDetectado:
        firstMatch(conteudo, cpfPattern) ||
        firstMatch(conteudo, cnpjPattern) ||
        trimmed.slice(0, 200),
      mensagemUsuario: CONTACT_BLOCK_MESSAGE,
    };
  }

  const mentionsPix = /\bpix\b|\bchave\s*pix\b/i.test(lower);

  const knownEmailDomains =
    /\b(gmail\.com|hotmail\.com|outlook\.com|yahoo\.com|icloud\.com|proton\.me|protonmail\.com)\b/i;

  const hasAtDomainOnly = /^[\s]*@[\w.-]+\.[a-z]{2,}[\s]*$/i.test(trimmed);
  const hasDomainOnly =
    /^[\s]*[a-z0-9.-]+\.[a-z]{2,}[\s]*$/i.test(trimmed) && /[a-z]/i.test(trimmed);
  const mentionsEmailProvider =
    /\b(gmail|hotmail|outlook|yahoo|icloud|proton(mail)?)\b/i.test(lower);
  const mentionsArroba = /\b(arroba|at)\b/i.test(lower);

  const emailFragment =
    hasAtDomainOnly ||
    knownEmailDomains.test(lower) ||
    (hasDomainOnly && knownEmailDomains.test(lower)) ||
    mentionsEmailProvider ||
    mentionsArroba;

  const isShort = trimmed.length <= 32;
  const noSpaces = !/\s/.test(trimmed);
  const hasSeparator = /[._-]/.test(trimmed);
  const looksLikeHandle =
    isShort &&
    noSpaces &&
    hasSeparator &&
    /[a-z]/i.test(trimmed) &&
    /^[a-z0-9][a-z0-9._-]{2,30}[a-z0-9]$/i.test(trimmed);

  const shortDigits = trimmed.length <= 12 && digitsOnly.length >= 6;
  const contactWords =
    /\b(whats|whatsapp|zap|telegram|insta|instagram|tiktok|facebook|contato|email|e-mail)\b/i.test(lower);

  const blockedByFragments =
    emailFragment ||
    shortDigits ||
    looksLikeHandle ||
    (contactWords && (hasAtDomainOnly || hasDomainOnly || looksLikeHandle || shortDigits));

  if (
    (mentionsPix && (emailFragment || shortDigits || phoneBrPattern.test(conteudo) || manyDigitsPattern.test(conteudo) || cpfPattern.test(conteudo) || cnpjPattern.test(conteudo))) ||
    blockedByFragments
  ) {
    return {
      blocked: true,
      motivo: mentionsPix ? 'DadoBancarioDetectado' : 'ContatoDetectado',
      trechoDetectado: trimmed.slice(0, 200),
      mensagemUsuario: CONTACT_BLOCK_MESSAGE,
    };
  }

  return { blocked: false };
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileNormalizedTerms(terms) {
  const normalized = [...new Set(
    (terms || [])
      .map((term) => normalizeForModeration(term))
      .filter(Boolean)
  )];

  const parts = normalized.map((term) =>
    term
      .split(' ')
      .filter(Boolean)
      .map(escapeRegex)
      .join('\\s+')
  );

  return new RegExp(`\\b(?:${parts.join('|')})\\b`, 'i');
}

const OFFENSIVE_TERM_GROUPS = {
  AmeacaExplicita: [
    'vou te matar',
    'te mato',
    'vou te arrebento',
    'vou te quebrar',
    'vou te pegar',
    'vou acabar com voce',
    'vou acabar com vc',
    'vou te foder',
    'te pego la fora',
    'tomara que voce morra',
    'voce vai pagar caro',
    'some daqui',
    'cala a boca',
    'cala tua boca',
    'vai morrer',
    'merece apanhar',
  ],
  DiscursoDiscriminatorio: [
    'viado',
    'viado de merda',
    'viadinho',
    'bicha',
    'bichinha',
    'boiola',
    'baitola',
    'traveco',
    'travecao',
    'sapatao',
    'sapatona',
    'aberracao',
    'pervertido',
    'doente sexual',
    'macaco',
    'macaca',
    'preto imundo',
    'preta imunda',
    'nego imundo',
    'neguinho imundo',
    'crioulo',
    'crioula',
    'escravo',
    'escrava',
    'raca ruim',
    'raca inferior',
    'sujo preto',
    'preto sujo',
    'neguinho burro',
    'baianada',
    'baiano preguicoso',
    'nordestino imundo',
    'nordestino burro',
    'gringo imundo',
    'judeu sujo',
    'arabe terrorista',
    'portugues burro',
    'argentino de merda',
    'alemao safado',
    'retardado',
    'retardada',
    'mongol',
    'mongoloide',
    'aleijado',
    'aleijada',
    'doente mental',
    'maluco',
    'maluca',
    'louco de merda',
    'psicopata',
    'autista de merda',
  ],
  AssedioSexual: [
    'gostosa',
    'delicia',
    'rabuda',
    'bunduda',
    'peituda',
    'mete',
    'me come',
    'quero te comer',
    'vou te comer',
    'senta aqui',
    'manda nude',
    'manda foto pelada',
    'puta gostosa',
    'cadela no cio',
  ],
  LinguagemOfensiva: [
    'merda',
    'bosta',
    'porra',
    'caralho',
    'cacete',
    'caceta',
    'foda',
    'foder',
    'fudido',
    'fudida',
    'foda se',
    'vai se foder',
    'vai tomar no cu',
    'tomar no cu',
    'pau no cu',
    'cu',
    'cuzao',
    'cuzona',
    'buceta',
    'xota',
    'xoxota',
    'piroca',
    'rola',
    'pau',
    'pica',
    'pinto',
    'punheta',
    'punheteiro',
    'siririca',
    'fdp',
    'f d p',
    'vsf',
    'v s f',
    'vtnc',
    'v t n c',
    'tmnc',
    't m n c',
    'tnc',
    't n c',
    'pqp',
    'krl',
    'crl',
    'karai',
    'karalho',
    'caraio',
    'mgr',
    'mrd',
    'fi da puta',
    'filho da puta',
    'filha da puta',
    'idiota',
    'imbecil',
    'burro',
    'burra',
    'babaca',
    'otario',
    'otario do caralho',
    'trouxa',
    'mane',
    'idiotice',
    'palhaco',
    'palhaca',
    'pateta',
    'anta',
    'energumeno',
    'asno',
    'tapado',
    'tapada',
    'animal',
    'debil',
    'verme',
    'lixo',
    'escroto',
    'escrota',
    'nojento',
    'nojenta',
    'infeliz',
    'desgracado',
    'desgracada',
    'arrombado',
    'arrombada',
    'arregacado',
    'arregacada',
    'seu merda',
    'sua merda',
    'seu lixo',
    'sua lixo',
    'seu idiota',
    'sua idiota',
    'seu imbecil',
    'sua imbecil',
    'seu burro',
    'sua burra',
    'seu otario',
    'sua otaria',
    'seu babaca',
    'sua babaca',
    'seu trouxa',
    'sua trouxa',
    'seu escroto',
    'sua escrota',
    'seu nojento',
    'sua nojenta',
    'seu verme',
    'sua praga',
    'seu desgracado',
    'sua desgracada',
    'puta',
    'puta que pariu',
    'piranha',
    'vagabunda',
    'vadia',
    'cadela',
    'prostituta',
    'rameira',
    'galinha',
    'ordinaria',
    'safada',
    'safado',
    'biscate',
    'rodada',
    'mulherzinha',
    'fubanga',
    'rapariga',
    'corno',
    'corno manso',
    'corno otario',
    'frouxo',
    'broxa',
    'mariquinha',
    'vagabundo',
    'mulambo',
    'feio pra caralho',
    'horroroso',
    'horrorosa',
    'ridiculo',
    'ridicula',
    'gordo imundo',
    'gorda imunda',
    'baleia',
    'obeso nojento',
    'magrela nojenta',
    'quatro olhos',
    'cara de rato',
    'cara de pau',
  ],
};

const OFFENSIVE_RULES = Object.entries(OFFENSIVE_TERM_GROUPS).map(([motivo, terms]) => ({
  motivo,
  pattern: compileNormalizedTerms(terms),
}));

function detectOffensiveLanguage(text) {
  const normalized = normalizeForModeration(text);
  if (!normalized) return { blocked: false };

  for (const rule of OFFENSIVE_RULES) {
    const match = normalized.match(rule.pattern);
    if (match?.[0]) {
      return {
        blocked: true,
        motivo: rule.motivo,
        trechoDetectado: String(match[0]).slice(0, 200),
        mensagemUsuario: OFFENSIVE_BLOCK_MESSAGE,
      };
    }
  }

  return { blocked: false };
}

export function moderateChatMessage(text) {
  const personalData = detectPersonalData(text);
  if (personalData.blocked) return personalData;

  const offensive = detectOffensiveLanguage(text);
  if (offensive.blocked) return offensive;

  return { blocked: false };
}

export default moderateChatMessage;
