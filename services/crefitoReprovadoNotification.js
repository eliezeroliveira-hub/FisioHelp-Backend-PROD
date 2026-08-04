function asPositiveId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${field} inválido.`);
  }
  return id;
}

function text(value) {
  return String(value ?? '').trim();
}

function limit(value, max) {
  const normalized = text(value);
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

export function montarNotificacoesCrefitoReprovado({
  fisioterapeutaId,
  fisioterapeutaNome,
  documentoId,
  motivo,
} = {}) {
  const fisioId = asPositiveId(fisioterapeutaId, 'FisioterapeutaId');
  const docId = asPositiveId(documentoId, 'DocumentoId');
  const motivoCompleto = limit(motivo, 500);
  if (!motivoCompleto) {
    throw new Error('Motivo de reprovação é obrigatório.');
  }

  const nome = text(fisioterapeutaNome) || 'Fisioterapeuta';
  const motivoPush = limit(motivoCompleto, 280);
  const dadosBase = {
    tipo: 'crefito_reprovado',
    fisioterapeutaId: fisioId,
    documentoId: docId,
    motivoRejeicao: motivoCompleto,
  };

  return Object.freeze({
    destinatario: Object.freeze({
      usuarioTipo: 'Fisioterapeuta',
      usuarioId: fisioId,
    }),
    push: Object.freeze({
      tipo: 'Credenciamento',
      titulo: 'CREFITO precisa de correção',
      mensagem: `Seu CREFITO não foi aprovado. Motivo: ${motivoPush}. Corrija o documento e envie novamente pelo app.`,
      referenciaId: docId,
      dados: Object.freeze({ ...dadosBase }),
    }),
    email: Object.freeze({
      tipo: 'Credenciamento',
      titulo: 'Seu CREFITO precisa de correção',
      mensagem: `Seu CREFITO não foi aprovado. Motivo: ${motivoCompleto}`,
      referenciaId: docId,
      dados: Object.freeze({
        ...dadosBase,
        emailModelo: 'crefito_reprovado',
        fisioterapeutaNome: nome,
      }),
    }),
  });
}

export default { montarNotificacoesCrefitoReprovado };
