import { HttpError } from './httpError.js';
import { normalizarDocumentoProfissional } from './professionalDocument.js';

/**
 * Monta o documento integral do prestador exclusivamente para respostas de
 * pré-checkout autenticadas. Nunca use este objeto em perfil ou busca pública.
 */
export function montarPrestadorCheckout(dados = {}) {
  try {
    const documento = normalizarDocumentoProfissional(dados);

    return Object.freeze({
      TipoPessoa: documento.TipoPessoa,
      DocumentoTipo: documento.DocumentoTipo,
      Documento: documento.DocumentoNormalizado,
    });
  } catch {
    throw new HttpError(500, 'Documento do prestador indisponível para o checkout.');
  }
}

export default { montarPrestadorCheckout };
