import crypto from 'node:crypto';
import { isIP } from 'node:net';

const SECRET_HEADER = 'x-fisiohelp-internal-secret';
const CLIENT_IP_HEADER = 'x-fisiohelp-client-ip';

function secretsMatch(received, expected) {
  if (!received || !expected) return false;
  const left = Buffer.from(String(received), 'utf8');
  const right = Buffer.from(String(expected), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizeClientIp(value) {
  const first = String(value || '').split(',')[0].trim();
  if (!first) return null;
  if (isIP(first)) return first;

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(first);
  if (bracketed && isIP(bracketed[1])) return bracketed[1];

  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(first);
  return ipv4WithPort && isIP(ipv4WithPort[1]) ? ipv4WithPort[1] : null;
}

export function trustedBffContext(req, _res, next) {
  const expectedSecret = String(process.env.BFF_INTERNAL_SECRET || '').trim();
  const receivedSecret = req.get(SECRET_HEADER);

  if (expectedSecret && secretsMatch(receivedSecret, expectedSecret)) {
    const clientIp = normalizeClientIp(req.get(CLIENT_IP_HEADER));
    if (clientIp) req.trustedBffClientIp = clientIp;
    req.isTrustedBff = true;
  }

  next();
}

export function requireTrustedBff(req, res, next) {
  if (req.isTrustedBff === true) return next();
  return res.status(403).json({ erro: 'Acesso restrito ao servidor web da FisioHelp.' });
}
