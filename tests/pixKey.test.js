import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularDigitosCNPJ } from '../utils/identityValidators.js';
import {
  normalizarChavePixAsaas,
  normalizarChavePixTelefoneAsaas,
  normalizarTipoChavePixAsaas,
} from '../utils/pixKey.js';

const CNPJ_BASE = '112223330001';
const CNPJ_VALIDO = `${CNPJ_BASE}${calcularDigitosCNPJ(CNPJ_BASE)}`;

test('normaliza telefone Pix com +55 para DDD e celular', () => {
  assert.equal(normalizarChavePixTelefoneAsaas('+5519991966887'), '19991966887');
});

test('normaliza telefone Pix com 55 sem sinal de mais', () => {
  assert.equal(normalizarChavePixTelefoneAsaas('5519991966887'), '19991966887');
});

test('normaliza telefone Pix formatado', () => {
  assert.equal(normalizarChavePixTelefoneAsaas('(19) 99196-6887'), '19991966887');
});

test('preserva telefone Pix já normalizado', () => {
  assert.equal(normalizarChavePixTelefoneAsaas('19991966887'), '19991966887');
});

test('preserva DDD 55 quando a chave já possui 11 dígitos', () => {
  assert.equal(normalizarChavePixTelefoneAsaas('55991966887'), '55991966887');
});

test('rejeita telefone sem o nono dígito', () => {
  assert.equal(normalizarChavePixTelefoneAsaas('1991966887'), null);
  assert.equal(normalizarChavePixTelefoneAsaas('+551991966887'), null);
});

test('rejeita telefone vazio ou com quantidade inválida de dígitos', () => {
  assert.equal(normalizarChavePixTelefoneAsaas(''), null);
  assert.equal(normalizarChavePixTelefoneAsaas(null), null);
  assert.equal(normalizarChavePixTelefoneAsaas('55199919668870'), null);
});

test('aceita CPF como tipo de chave Pix e remove a formatação', () => {
  assert.equal(normalizarTipoChavePixAsaas(' cpf '), 'CPF');
  assert.equal(normalizarChavePixAsaas('CPF', '529.982.247-25'), '52998224725');
});

test('rejeita chave Pix CPF inválida', () => {
  assert.throws(
    () => normalizarChavePixAsaas('CPF', '111.111.111-11'),
    /Chave Pix CPF inválida/
  );
});

test('mantém normalização de CNPJ, e-mail, telefone e EVP', () => {
  assert.equal(normalizarChavePixAsaas('CNPJ', CNPJ_VALIDO), CNPJ_VALIDO);
  assert.equal(normalizarChavePixAsaas('EMAIL', ' FISIO@EXEMPLO.COM '), 'fisio@exemplo.com');
  assert.equal(normalizarChavePixAsaas('PHONE', '+5519991966887'), '19991966887');
  assert.equal(
    normalizarChavePixAsaas('EVP', '550E8400-E29B-41D4-A716-446655440000'),
    '550e8400-e29b-41d4-a716-446655440000'
  );
});

test('mantém aliases aceitos para telefone e chave aleatória', () => {
  assert.equal(normalizarTipoChavePixAsaas('telefone'), 'PHONE');
  assert.equal(normalizarTipoChavePixAsaas('celular'), 'PHONE');
  assert.equal(normalizarTipoChavePixAsaas('aleatória'), 'EVP');
  assert.equal(normalizarTipoChavePixAsaas('chave_aleatoria'), 'EVP');
});
