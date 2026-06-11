// utils/formatarCrefito.js
export function formatarCrefito(valor, estado = 'SP') {
  if (!valor) return null;

  const raw = String(valor).trim().toUpperCase();
  let numero = raw.replace(/^CREFITO\s+/i, '').trim();

  // pega só os dígitos (ex.: "CREFITO 19786-F / SP" -> "19786")
  const digits = numero.replace(/\D/g, '');
  if (digits) numero = `${digits}-F`;

  const uf = String(estado || 'SP').trim().toUpperCase();
  return `CREFITO ${numero} / ${uf}`;
}
