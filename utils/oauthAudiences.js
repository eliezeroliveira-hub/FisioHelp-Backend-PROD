export function splitOAuthAudiences(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildOAuthAudiences(...values) {
  return Array.from(new Set(values.flatMap(splitOAuthAudiences)));
}

export function verificationAudience(audiences) {
  return audiences.length === 1 ? audiences[0] : audiences;
}

export function tokenHasAllowedAudience(tokenAudience, allowedAudiences) {
  const actualAudiences = Array.isArray(tokenAudience)
    ? tokenAudience.map((item) => String(item || '').trim()).filter(Boolean)
    : splitOAuthAudiences(tokenAudience);

  return actualAudiences.some((audience) => allowedAudiences.includes(audience));
}
