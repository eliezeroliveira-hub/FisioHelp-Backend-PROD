import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizarChavePixTelefoneAsaas } from '../utils/pixKey.js';

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
