// services/oauthService.js
import { OAuth2Client } from "google-auth-library";
import appleSigninAuth from "apple-signin-auth";
import { ENV } from "../config/env.js";
import { log } from "../config/logger.js";
import {
  buildOAuthAudiences,
  tokenHasAllowedAudience,
  verificationAudience,
} from "../utils/oauthAudiences.js";

let googleClient = null;

function getGoogleClient() {
  if (!googleClient) {
    googleClient = new OAuth2Client();
  }
  return googleClient;
}

function getGoogleAudiences() {
  return buildOAuthAudiences(ENV.GOOGLE_CLIENT_ID, ENV.GOOGLE_CLIENT_IDS);
}

function getAppleAudiences() {
  return buildOAuthAudiences(ENV.APPLE_CLIENT_ID, ENV.APPLE_CLIENT_IDS);
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
      audience: verificationAudience(audiences),
    });
    const payload = ticket?.getPayload();

    if (!payload || payload.email_verified !== true) {
      throw new Error("Token Google inválido ou e-mail não verificado.");
    }
    if (!audiences.includes(String(payload.aud || ""))) {
      throw new Error("Token Google inválido para este aplicativo (audience mismatch).");
    }
    // TODO: O SDK nativo gratuito do Google Sign-In não suporta nonce.
    // Reavaliar Universal Sign In/Credential Manager antes do hardening final de produção.
    const expectedGoogleNonce = String(expectedNonce || "").trim();
    if (expectedGoogleNonce) {
      assertTokenNonce("Google", payload.nonce, expectedGoogleNonce);
    }

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
    const audiences = getAppleAudiences();
    if (!audiences.length) {
      throw new Error("Configuração ausente: APPLE_CLIENT_ID ou APPLE_CLIENT_IDS.");
    }

    const decoded = await appleSigninAuth.verifyIdToken(idToken, {
      audience: verificationAudience(audiences),
      ignoreExpiration: false
    });

    if (!decoded?.sub) throw new Error("Token Apple inválido.");
    if (!tokenHasAllowedAudience(decoded.aud, audiences)) {
      throw new Error("Token Apple inválido para este aplicativo (audience mismatch).");
    }
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
