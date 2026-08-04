import {
  normalizarChavePixAsaas,
  normalizarTipoChavePixAsaas,
} from './pixKey.js';
import {
  obterDocumentoTitularParaGateway,
  resolverTitularFinanceiro,
  validarChavePixDocumentalDoTitular,
} from './professionalFinancial.js';

function text(value, max = 500) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function toMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function hasPixDestination(lote) {
  return Boolean(text(lote?.ChavePix, 140) && text(lote?.TipoChavePix, 20));
}

function parseBankCode(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/\d{3}/);
  return match ? match[0] : null;
}

function parseAccount(value) {
  const raw = String(value ?? '').trim();
  const parts = raw.toUpperCase().split('-');
  if (parts.length >= 2 && parts[0]) {
    const account = parts.slice(0, -1).join('');
    const digit = parts[parts.length - 1] || '';
    return {
      account: onlyDigits(account),
      accountDigit: digit.replace(/[^0-9X]/g, '').slice(0, 1) || null,
    };
  }

  return {
    account: onlyDigits(raw),
    accountDigit: null,
  };
}

function normalizeBankAccountType(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw.includes('poup')) return 'CONTA_POUPANCA';
  return 'CONTA_CORRENTE';
}

function buildDescricaoLote(lote) {
  return text(`Repasse FisioHelp lote ${lote.Id}`, 140);
}

export function buildBankAccountTransferPayload(lote) {
  const titular = resolverTitularFinanceiro(lote);
  const bankCode = parseBankCode(lote.Banco);
  const agency = onlyDigits(lote.Agencia);
  const { account, accountDigit } = parseAccount(lote.Conta);
  const cpfCnpj = obterDocumentoTitularParaGateway(titular);
  const ownerName = text(lote.NomeFisioterapeuta ?? lote.Nome, 100);

  if (!bankCode || !agency || !account || !accountDigit || !ownerName) {
    throw new Error(
      'Dados bancários do fisioterapeuta incompletos: banco, agência, conta com dígito, titular e CPF/CNPJ válido são obrigatórios para repasse TED.'
    );
  }

  return {
    value: toMoney(lote.ValorTransferencia),
    bankAccount: {
      bank: { code: bankCode },
      ownerName,
      cpfCnpj,
      agency,
      account,
      accountDigit,
      bankAccountType: normalizeBankAccountType(lote.TipoContaBancaria),
    },
    operationType: 'TED',
    externalReference: `REPASSE_${lote.Id}`,
  };
}

export function buildAsaasTransferPayload(lote) {
  if (!hasPixDestination(lote)) {
    return buildBankAccountTransferPayload(lote);
  }

  const tipoChavePix = normalizarTipoChavePixAsaas(lote.TipoChavePix);
  if (!tipoChavePix) {
    throw new Error('Tipo de chave Pix inválido para transferência.');
  }

  const chavePix = normalizarChavePixAsaas(tipoChavePix, lote.ChavePix);
  if (tipoChavePix === 'CPF' || tipoChavePix === 'CNPJ') {
    validarChavePixDocumentalDoTitular(
      { tipoChavePix, chavePix },
      resolverTitularFinanceiro(lote)
    );
  }

  return {
    value: toMoney(lote.ValorTransferencia),
    operationType: 'PIX',
    pixAddressKey: chavePix,
    pixAddressKeyType: tipoChavePix,
    description: buildDescricaoLote(lote),
    externalReference: `REPASSE_${lote.Id}`,
  };
}

export default {
  buildAsaasTransferPayload,
  buildBankAccountTransferPayload,
};
