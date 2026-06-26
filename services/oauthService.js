// services/oauthService.js
import { OAuth2Client } from "google-auth-library";
import appleSigninAuth from "apple-signin-auth";
import { ENV } from "../config/env.js";
import { log } from "../config/logger.js";

let googleClient = null;

function getGoogleClient() {
  if (!googleClient) {
    googleClient = new OAuth2Client();
  }
  return googleClient;
}

function splitOAuthAudiences(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getGoogleAudiences() {
  return Array.from(new Set([
    ...splitOAuthAudiences(ENV.GOOGLE_CLIENT_ID),
    ...splitOAuthAudiences(ENV.GOOGLE_CLIENT_IDS),
  ]));
}

function normalizeExpectedNonce(value) {
  const nonce = String(value || "").trim();
  if (!nonce) {
    throw new Error("Nonce OAuth ausente.");
  }
  return nonce;
}

function assertTokenNonce(provider, actualNonce, expectedNonce) {
  const expected = normalizeExpectedNonce(expectedNonce);
  if (!actualNonce || String(actualNonce) !== expected) {
    throw new Error(`Nonce OAuth inválido para ${provider}.`);
  }
}

export async function validarGoogleToken(idToken, expectedNonce) {
  try {
    const audiences = getGoogleAudiences();
    if (!audiences.length) {
      throw new Error("Configuração ausente: GOOGLE_CLIENT_ID ou GOOGLE_CLIENT_IDS.");
    }

    const ticket = await getGoogleClient().verifyIdToken({
      idToken,
      audience: audiences.length === 1 ? audiences[0] : audiences,
    });
    const payload = ticket?.getPayload();

    if (!payload || payload.email_verified !== true) {
      throw new Error("Token Google inválido ou e-mail não verificado.");
    }
    if (!audiences.includes(String(payload.aud || ""))) {
      throw new Error("Token Google inválido para este aplicativo (audience mismatch).");
    }
    assertTokenNonce("Google", payload.nonce, expectedNonce);

    return {
      email: payload.email,
      nome: payload.name || "Usuário Google",
      emailVerificado: true,
      provedor: "google",
      sub: payload.sub,
    };
  } catch (err) {
    log("error", "Erro ao validar token Google", { erro: err?.message || err });
    throw new Error("Falha na validação do token Google");
  }
}

export async function validarAppleToken(idToken, expectedNonce) {
  try {
    const audience = ENV.APPLE_CLIENT_ID;
    if (!audience) {
      throw new Error("Configuração ausente: APPLE_CLIENT_ID.");
    }

    const decoded = await appleSigninAuth.verifyIdToken(idToken, {
      audience,
      ignoreExpiration: false
    });

    if (!decoded?.sub) throw new Error("Token Apple inválido.");
    assertTokenNonce("Apple", decoded.nonce, expectedNonce);

    return {
      sub: decoded.sub,
      email: decoded.email || null,
      emailVerificado:
        decoded.email_verified === true
        || decoded.email_verified === "true"
        || Boolean(decoded.email),
      provedor: "apple",
    };
  } catch (err) {
    log("error", "Erro ao validar token Apple", { erro: err?.message || err });
    throw new Error("Falha na validação do token Apple");
  }
}
