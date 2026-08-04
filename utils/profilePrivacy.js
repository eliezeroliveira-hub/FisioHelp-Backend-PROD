/**
 * Remove campos de CPF de objetos destinados a respostas públicas.
 *
 * A proteção é case-insensitive e também cobre aliases futuros como
 * FisioterapeutaCPF. O documento mascarado permanece disponível porque o
 * nome da propriedade não termina em "CPF".
 */
export function protegerPerfilPublicoDeCpf(perfil) {
  if (!perfil || typeof perfil !== 'object' || Array.isArray(perfil)) {
    return perfil;
  }

  return Object.fromEntries(
    Object.entries(perfil).filter(([chave]) => !/cpf$/i.test(chave))
  );
}
