// 📁 middleware/chatMessageGuard.js
// Bloqueia envio de links / contatos / dados pessoais no chat.
// Observação: se vier apenas documentoPacienteId (sem conteudo),
// o chatService pode gerar o conteúdo automaticamente — então deixamos passar.
import { isValidCNPJ } from "../utils/identityValidators.js";

function firstValidCnpj(text) {
  const conteudo = String(text || "");
  const patterns = [
    /\b[A-Z0-9]{2}[.\s]?[A-Z0-9]{3}[.\s]?[A-Z0-9]{3}[/\s]?[A-Z0-9]{4}[\s-]?\d{2}\b/gi,
    /\b[A-Z0-9]{12}\d{2}\b/gi,
  ];

  for (const pattern of patterns) {
    const matches = conteudo.matchAll(pattern);
    for (const match of matches) {
      const candidate = match?.[0] || "";
      if (isValidCNPJ(candidate)) return candidate;
    }
  }

  return null;
}

export default function chatMessageGuard(req, res, next) {
  const body = req.body || {};

  const documentoPacienteId = body.documentoPacienteId;
  const temDocumento = documentoPacienteId !== undefined && documentoPacienteId !== null;

  const conteudoRaw = body.conteudo;
  const conteudo = (conteudoRaw === undefined || conteudoRaw === null) ? "" : String(conteudoRaw).trim();

  // Mensagem "de documento" (service monta o texto)
  if (!conteudo && temDocumento) return next();

  if (!conteudo) {
    return res.status(400).json({ sucesso: false, erro: "Mensagem vazia." });
  }

  // limite simples anti-spam
  if (conteudo.length > 2000) {
    return res.status(400).json({ sucesso: false, erro: "Mensagem muito longa." });
  }

  const trimmed = conteudo.trim();
  const lower = conteudo.toLowerCase();
  const digitsOnly = conteudo.replace(/\D/g, "");

  // ---------------------------
  // 1) Links (inclui encurtadores e rotas comuns de contato)
  // ---------------------------
  const hasLink =
    /(https?:\/\/|www\.|wa\.me\/|t\.me\/|bit\.ly\/|tinyurl\.com\/|instagram\.com\/|facebook\.com\/|linktr\.ee\/)/i.test(conteudo);

  // ---------------------------
  // 2) Email completo
  // ---------------------------
  const hasEmail =
    /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i.test(conteudo);

  // ---------------------------
  // 3) Telefones (BR e genérico)
  // ---------------------------
  const hasPhoneBR =
    /(\+?55\s*)?(\(?\d{2}\)?\s*)?(9?\d{4})[-\s.]?\d{4}\b/i.test(conteudo);

  const hasManyDigits =
    /(?:\d[\s().-]?){10,14}\d/.test(conteudo);

  // ---------------------------
  // 4) CPF/CNPJ (padrão estruturado)
  // Evita falso positivo por "soma de números" da frase inteira.
  // ---------------------------
  const hasCPF =
    /\b\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[.\s-]?\d{2}\b/.test(conteudo);
  const hasCNPJ = Boolean(firstValidCnpj(conteudo));

  // ---------------------------
  // 5) PIX / chave
  // ---------------------------
  const mentionsPix = /\bpix\b|\bchave\s*pix\b/i.test(lower);

  // =========================================================
  // NOVO: bloquear "fragmentos" e "burlas" em mensagens separadas
  // =========================================================

  // 6) Fragmentos típicos de e-mail (ex.: "@gmail.com", "gmail.com", "gmail", "arroba gmail")
  const knownEmailDomains =
    /\b(gmail\.com|hotmail\.com|outlook\.com|yahoo\.com|icloud\.com|proton\.me|protonmail\.com)\b/i;

  const hasAtDomainOnly =
    /^[\s]*@[\w.-]+\.[a-z]{2,}[\s]*$/i.test(trimmed);

  const hasDomainOnly =
    /^[\s]*[a-z0-9.-]+\.[a-z]{2,}[\s]*$/i.test(trimmed) && /[a-z]/i.test(trimmed);

  const mentionsEmailProvider =
    /\b(gmail|hotmail|outlook|yahoo|icloud|proton(mail)?)\b/i.test(lower);

  const mentionsArroba =
    /\b(arroba|at)\b/i.test(lower);

  const emailFragment =
    hasAtDomainOnly ||
    knownEmailDomains.test(lower) ||
    (hasDomainOnly && knownEmailDomains.test(lower)) ||
    mentionsEmailProvider ||
    mentionsArroba;

  // 7) Handle/username “solto” (ex.: "eliezer.oliveira94", "ana_coser", "dr-joao123")
  // - sem espaços
  // - tamanho curto (pra evitar bloquear frases)
  // - contém . _ ou - (característico de usuário)
  const isShort = trimmed.length <= 32;
  const noSpaces = !/\s/.test(trimmed);
  const hasSeparator = /[._-]/.test(trimmed);
  const looksLikeHandle =
    isShort &&
    noSpaces &&
    hasSeparator &&
    /[a-z]/i.test(trimmed) &&
    /^[a-z0-9][a-z0-9._-]{2,30}[a-z0-9]$/i.test(trimmed);

  // 8) Mensagens curtas com muitos dígitos (ex.: pedaço de telefone, chave, token etc.)
  // Mantém permissivo para textos normais com números.
  const shortDigits = trimmed.length <= 12 && digitsOnly.length >= 6;

  // 9) Palavras de “contato” (reforça bloqueio quando tentam “sinalizar” que é contato)
  const contactWords =
    /\b(whats|whatsapp|zap|telegram|insta|instagram|tiktok|facebook|contato|email|e-mail)\b/i.test(lower);

  // Se o usuário mandar só um handle + palavras de contato em outra msg,
  // aqui bloqueia handle “puro” também.
  const blockedByFragments =
    emailFragment ||
    shortDigits ||
    looksLikeHandle ||
    (contactWords && (hasAtDomainOnly || hasDomainOnly || looksLikeHandle || shortDigits));

  // ---------------------------
  // Consolidação
  // ---------------------------
  const blocked =
    hasLink ||
    hasEmail ||
    hasPhoneBR ||
    hasManyDigits ||
    hasCPF ||
    hasCNPJ ||
    (mentionsPix && (hasEmail || hasPhoneBR || hasManyDigits || hasCPF || hasCNPJ)) ||
    blockedByFragments;

  if (blocked) {
    return res.status(400).json({
      sucesso: false,
      erro: "Mensagem bloqueada: não é permitido compartilhar links ou dados pessoais (telefone, e-mail, CPF/CNPJ, Pix)."
    });
  }

  return next();
}
