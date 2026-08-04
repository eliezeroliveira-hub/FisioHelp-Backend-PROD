import { isCNPJAlfanumerico } from './identityValidators.js';
import { HttpError } from './httpError.js';
import { normalizarDocumentoProfissional } from './professionalDocument.js';

export const CNPJ_ALFANUMERICO_REPASSE_MSG =
  'CNPJ alfanumérico ainda não é suportado pelo gateway para repasse via TED ou chave Pix do tipo CNPJ. Para receber repasses, cadastre uma chave Pix do tipo e-mail, telefone ou chave aleatória.';

export function resolverTitularFinanceiro(dados = {}) {
  try {
    const documento = normalizarDocumentoProfissional(dados);
    return Object.freeze({
      TipoPessoa: documento.TipoPessoa,
      DocumentoTipo: documento.DocumentoTipo,
      Documento: documento.DocumentoNormalizado,
    });
  } catch {
    throw new HttpError(400, 'Documento cadastral do fisioterapeuta inválido para repasse.');
  }
}

export function obterDocumentoTitularParaGateway(titular) {
  if (!titular?.Documento || !['CPF', 'CNPJ'].includes(titular?.DocumentoTipo)) {
    throw new HttpError(400, 'CPF/CNPJ do titular é obrigatório para repasse bancário.');
  }

  if (titular.DocumentoTipo === 'CNPJ' && isCNPJAlfanumerico(titular.Documento)) {
    throw new HttpError(400, CNPJ_ALFANUMERICO_REPASSE_MSG);
  }

  return titular.Documento;
}

export function validarChavePixDocumentalDoTitular({ tipoChavePix, chavePix }, titular) {
  const tipo = String(tipoChavePix ?? '').trim().toUpperCase();
  if (!['CPF', 'CNPJ'].includes(tipo)) return;

  if (tipo !== titular?.DocumentoTipo || chavePix !== titular?.Documento) {
    throw new HttpError(
      400,
      `A chave Pix ${tipo} deve ser igual ao ${tipo} cadastrado do fisioterapeuta.`
    );
  }
}

export default {
  CNPJ_ALFANUMERICO_REPASSE_MSG,
  resolverTitularFinanceiro,
  obterDocumentoTitularParaGateway,
  validarChavePixDocumentalDoTitular,
};
