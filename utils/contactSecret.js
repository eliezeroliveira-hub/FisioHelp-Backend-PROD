import { HttpError } from './httpError.js';

export function getContatoSecret() {
  const secret =
    process.env.CONTATO_HMAC_SECRET ||
    process.env.APP_SECRET ||
    process.env.JWT_SECRET;

  if (!secret) {
    throw new HttpError(
      500,
      'Segredo de contato não configurado. Defina CONTATO_HMAC_SECRET (ou APP_SECRET/JWT_SECRET).'
    );
  }

  return secret;
}
