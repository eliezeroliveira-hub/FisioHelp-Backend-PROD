// services/oauthService.js
import { OAuth2Client } from "google-auth-library";
import appleSigninAuth from "apple-signin-auth";
import { ENV } from "../config/env.js";
import { log } from "../config/logger.js";

let googleClient = null;
let googleClientAudience = null;

function getGoogleClient(audience) {
  if (!googleClient || googleClientAudience !== audience) {
    googleClient = new OAuth2Client(audience);
    googleClientAudience = audience;
  }
  return googleClient;
}

export async function validarGoogleToken(idToken) {
  try {
    const audience = ENV.GOOGLE_CLIENT_ID;
    if (!audience) {
      throw new Error("Configuração ausente: GOOGLE_CLIENT_ID.");
    }

    const ticket = await getGoogleClient(audience).verifyIdToken({
      idToken,
      audience
    });
    const payload = ticket?.getPayload();

    if (!payload || payload.email_verified !== true) {
      throw new Error("Token Google inválido ou e-mail não verificado.");
    }
    if (String(payload.aud || "") !== String(audience)) {
      throw new Error("Token Google inválido para este aplicativo (audience mismatch).");
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

export async function validarAppleToken(idToken) {
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
