export function normalizeAuthUserType(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'admin' || normalized === 'administrador' || normalized === 'administradores') {
    return 'Admin';
  }
  if (normalized === 'paciente') return 'Paciente';
  if (normalized === 'fisioterapeuta' || normalized === 'fisio') return 'Fisioterapeuta';
  return String(value).trim();
}

/**
 * Normaliza uma linha devolvida pelas procedures mínimas de autenticação.
 * Aceita os aliases Cpf/CPF e Cnpj/CNPJ para preservar procedures legadas.
 */
export function mapAuthLoginResult(row, { fallbackType = null } = {}) {
  if (!row || typeof row !== 'object') return null;

  const id = Number(row.Id ?? row.id);
  const tipo = normalizeAuthUserType(row.Tipo ?? row.tipo ?? fallbackType);
  if (!Number.isInteger(id) || id <= 0 || !tipo) return null;

  return {
    tipo,
    id,
    nome: row.Nome ?? row.nome ?? null,
    email: row.Email ?? row.email ?? null,
    senhaHash: row.SenhaHash ?? row.senhaHash ?? null,
    ativo: row.Ativo ?? row.ativo ?? null,
    isBloqueado: row.IsBloqueado ?? row.isBloqueado ?? null,
    nivelAcesso: row.NivelAcesso ?? row.nivelAcesso ?? null,
    cpf: row.Cpf ?? row.CPF ?? row.cpf ?? null,
    cnpj: row.Cnpj ?? row.CNPJ ?? row.cnpj ?? null,
  };
}

export default {
  normalizeAuthUserType,
  mapAuthLoginResult,
};
