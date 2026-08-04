import { formatCNPJ, formatCPF } from './identityValidators.js';
import { normalizarDocumentoProfissional } from './professionalDocument.js';

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeRole(value) {
  return text(value) || 'Profissional';
}

/**
 * Apresenta o documento do fisioterapeuta somente em contextos privados da
 * contratação, como checkout autenticado, recibos e e-mails transacionais.
 *
 * Em caso de dado legado inconsistente, não propaga o documento bruto nem
 * interrompe a comunicação: usa um rótulo neutro e o valor de ausência.
 */
export function montarDocumentoProfissionalApresentacao(
  dados = {},
  { papel = 'Profissional', valorAusente = 'não informado' } = {}
) {
  const papelNormalizado = normalizeRole(papel);
  const ausencia = text(valorAusente) || 'não informado';

  try {
    const documento = normalizarDocumentoProfissional(dados);
    const valorFormatado = documento.DocumentoTipo === 'CPF'
      ? formatCPF(documento.DocumentoNormalizado)
      : formatCNPJ(documento.DocumentoNormalizado);

    return Object.freeze({
      tipoPessoa: documento.TipoPessoa,
      documentoTipo: documento.DocumentoTipo,
      documento: documento.DocumentoNormalizado,
      rotulo: `${documento.DocumentoTipo} do ${papelNormalizado}`,
      valorFormatado: valorFormatado || ausencia,
    });
  } catch {
    return Object.freeze({
      tipoPessoa: null,
      documentoTipo: null,
      documento: null,
      rotulo: `CPF/CNPJ do ${papelNormalizado}`,
      valorFormatado: ausencia,
    });
  }
}

export default { montarDocumentoProfissionalApresentacao };
