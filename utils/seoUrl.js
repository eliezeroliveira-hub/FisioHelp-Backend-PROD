export const SEO_SITE_ORIGIN = 'https://fisiohelp.com.br';

export function slugifySeo(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function buildSeoProfilePath(profile) {
  const id = Number(profile?.fisioterapeutaId ?? profile?.FisioterapeutaId);
  const nome = slugifySeo(profile?.nome ?? profile?.Nome);
  const cidade = slugifySeo(profile?.cidade ?? profile?.Cidade);
  const estado = String(profile?.estado ?? profile?.Estado ?? '').trim().toLowerCase();
  if (!Number.isInteger(id) || id <= 0 || !nome || !cidade || !/^[a-z]{2}$/.test(estado)) return null;
  return `/fisioterapeutas/${nome}-${id}/${estado}/${cidade}`;
}

export function buildSeoCityPath(profile) {
  const cidade = slugifySeo(profile?.cidade ?? profile?.Cidade);
  const estado = String(profile?.estado ?? profile?.Estado ?? '').trim().toLowerCase();
  return cidade && /^[a-z]{2}$/.test(estado) ? `/fisioterapeutas/${estado}/${cidade}` : null;
}
