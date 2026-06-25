import { isIP } from 'node:net';

function stripPortFromIp(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (isIP(raw)) return raw;

  const bracketed = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed && isIP(bracketed[1])) return bracketed[1];

  const ipv4WithPort = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPort && isIP(ipv4WithPort[1])) return ipv4WithPort[1];

  return raw;
}

export function getClientIp(req) {
  const trustedIp = stripPortFromIp(req?.ip);
  if (trustedIp) return trustedIp;

  const socketIp = stripPortFromIp(req?.socket?.remoteAddress);
  return socketIp || 'unknown';
}

export function rateLimitKeyByIp(req) {
  return getClientIp(req);
}
