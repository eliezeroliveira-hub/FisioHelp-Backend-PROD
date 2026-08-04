const CAMPO_DOCUMENTO_PROFISSIONAL_PUBLICO = /(?:cpf|cnpj)$/i;

function campoProfissionalSensivel(chave) {
  return (
    CAMPO_DOCUMENTO_PROFISSIONAL_PUBLICO.test(chave) ||
    /^TipoPessoa$/i.test(chave) ||
    /^DocumentoProfissional/i.test(chave)
  );
}

/**
 * Remove documentos cadastrais do fisioterapeuta de respostas públicas.
 *
 * A proteção cobre CPF/CNPJ completos, aliases terminados nesses nomes,
 * TipoPessoa e representações mascaradas que não são usadas no perfil.
 */
export function protegerPerfilPublicoDeDocumento(perfil) {
  if (!perfil || typeof perfil !== 'object' || Array.isArray(perfil)) {
    return perfil;
  }

  return Object.fromEntries(
    Object.entries(perfil).filter(([chave]) => !campoProfissionalSensivel(chave))
  );
}
