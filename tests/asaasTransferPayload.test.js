import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { calcularDigitosCNPJ } from '../utils/identityValidators.js';
import {
  buildAsaasTransferPayload,
  buildBankAccountTransferPayload,
} from '../utils/asaasTransferPayload.js';

const CPF = '52998224725';
const OUTRO_CPF = '16899535009';
const CNPJ_BASE = '112223330001';
const CNPJ = `${CNPJ_BASE}${calcularDigitosCNPJ(CNPJ_BASE)}`;
const CNPJ_ALPHA_BASE = 'AB12CD34EF56';
const CNPJ_ALPHA = `${CNPJ_ALPHA_BASE}${calcularDigitosCNPJ(CNPJ_ALPHA_BASE)}`;

function loteBase(overrides = {}) {
  return {
    Id: 77,
    ValorTransferencia: 125.4,
    NomeFisioterapeuta: 'Fisioterapeuta Teste',
    TipoPessoa: 'PF',
    CPF,
    CNPJ: null,
    Banco: '001 - Banco do Brasil',
    Agencia: '1234',
    Conta: '98765-4',
    TipoContaBancaria: 'Corrente',
    ChavePix: null,
    TipoChavePix: null,
    ...overrides,
  };
}

test('monta TED para titular PF usando CPF cadastrado e nome do fisioterapeuta', () => {
  const payload = buildBankAccountTransferPayload(loteBase());
  assert.deepEqual(payload, {
    value: 125.4,
    bankAccount: {
      bank: { code: '001' },
      ownerName: 'Fisioterapeuta Teste',
      cpfCnpj: CPF,
      agency: '1234',
      account: '98765',
      accountDigit: '4',
      bankAccountType: 'CONTA_CORRENTE',
    },
    operationType: 'TED',
    externalReference: 'REPASSE_77',
  });
});

test('monta TED para titular PJ usando CNPJ cadastrado', () => {
  const payload = buildBankAccountTransferPayload(loteBase({
    TipoPessoa: 'PJ',
    CPF: null,
    CNPJ,
  }));
  assert.equal(payload.bankAccount.cpfCnpj, CNPJ);
});

test('monta Pix CPF normalizado quando a chave pertence ao titular PF', () => {
  const payload = buildAsaasTransferPayload(loteBase({
    ChavePix: '529.982.247-25',
    TipoChavePix: 'cpf',
  }));
  assert.equal(payload.operationType, 'PIX');
  assert.equal(payload.pixAddressKeyType, 'CPF');
  assert.equal(payload.pixAddressKey, CPF);
});

test('rejeita chave Pix CPF diferente do CPF cadastrado', () => {
  assert.throws(
    () => buildAsaasTransferPayload(loteBase({
      ChavePix: OUTRO_CPF,
      TipoChavePix: 'CPF',
    })),
    /deve ser igual ao CPF cadastrado/
  );
});

test('rejeita chave Pix documental incompatível com o tipo de pessoa', () => {
  assert.throws(
    () => buildAsaasTransferPayload(loteBase({
      ChavePix: CNPJ,
      TipoChavePix: 'CNPJ',
    })),
    /deve ser igual ao CNPJ cadastrado/
  );
});

test('monta Pix CNPJ somente quando a chave pertence ao titular PJ', () => {
  const payload = buildAsaasTransferPayload(loteBase({
    TipoPessoa: 'PJ',
    CPF: null,
    CNPJ,
    ChavePix: CNPJ,
    TipoChavePix: 'CNPJ',
  }));
  assert.equal(payload.pixAddressKeyType, 'CNPJ');
  assert.equal(payload.pixAddressKey, CNPJ);
});

test('mantém Pix por e-mail e telefone disponível para PF', () => {
  const email = buildAsaasTransferPayload(loteBase({
    ChavePix: ' FISIO@EXEMPLO.COM ',
    TipoChavePix: 'EMAIL',
  }));
  assert.equal(email.pixAddressKey, 'fisio@exemplo.com');

  const phone = buildAsaasTransferPayload(loteBase({
    ChavePix: '+5519991966887',
    TipoChavePix: 'PHONE',
  }));
  assert.equal(phone.pixAddressKey, '19991966887');
});

test('bloqueia CNPJ alfanumérico em TED, mas permite Pix não documental', () => {
  const pjAlfanumerica = loteBase({
    TipoPessoa: 'PJ',
    CPF: null,
    CNPJ: CNPJ_ALPHA,
  });

  assert.throws(
    () => buildBankAccountTransferPayload(pjAlfanumerica),
    /CNPJ alfanumérico ainda não é suportado/
  );

  const payload = buildAsaasTransferPayload({
    ...pjAlfanumerica,
    ChavePix: 'fisiopj@exemplo.com',
    TipoChavePix: 'EMAIL',
  });
  assert.equal(payload.pixAddressKey, 'fisiopj@exemplo.com');
});

test('serviço de repasses seleciona TipoPessoa e CPF e usa o montador isolado', () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(currentDir, '../services/repassesGatewayService.js'),
    'utf8'
  );

  assert.match(source, /import \{ buildAsaasTransferPayload \}/);
  assert.match(source, /f\.TipoPessoa/);
  assert.match(source, /f\.CPF/);
  assert.doesNotMatch(source, /function buildAsaasTransferPayload\(/);
  assert.equal(
    [...source.matchAll(/f\.TipoPessoa = N'PF'[\s\S]{0,180}?f\.CPF/g)].length,
    2
  );
});

test('atualização bancária usa o documento PF/PJ e protege chaves documentais', () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(currentDir, '../services/fisioterapeutasService.js'),
    'utf8'
  );

  assert.match(source, /SELECT TOP \(1\) TipoPessoa, CPF, CNPJ/);
  assert.match(source, /normalizarChavePixAsaas\(tipoPix, chaveRaw\)/);
  assert.match(source, /validarChavePixDocumentalDoTitular/);
  assert.match(source, /obterDocumentoTitularParaGateway/);
  assert.doesNotMatch(source, /validarCnpjRepasseAutomatico/);
});

test('V132 é protegida, transacional, idempotente e preserva o pareamento Pix', () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const migration = fs.readFileSync(
    path.resolve(currentDir, '../sql/FISIOTERAPEUTAS_PIX_CPF_V132.sql'),
    'utf8'
  );

  assert.match(migration, /MigrationExpectedDatabase/);
  assert.match(migration, /MigrationDryRun/);
  assert.match(migration, /BEGIN TRANSACTION/);
  assert.match(migration, /CK_Fisioterapeutas_TipoChavePix/);
  assert.match(migration, /CK_Fisioterapeutas_ChavePix_Tipo/);
  assert.match(migration, /N'CPF'/);
  assert.match(migration, /IF OBJECT_ID\(N'dbo\.CK_Fisioterapeutas_TipoChavePix', N'C'\) IS NOT NULL/);
});
