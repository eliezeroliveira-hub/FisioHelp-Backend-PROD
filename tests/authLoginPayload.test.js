import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAuthLoginPayload } from '../utils/authLoginPayload.js';

const CNPJ_ALFANUMERICO_TRES_LETRAS = '12ABC345678990';

test('respeita CNPJ explícito mesmo quando ele contém exatamente 11 dígitos', () => {
  assert.deepEqual(
    buildAuthLoginPayload({
      cnpj: CNPJ_ALFANUMERICO_TRES_LETRAS,
      senha: 'senha-teste',
    }),
    {
      cnpj: CNPJ_ALFANUMERICO_TRES_LETRAS,
      senha: 'senha-teste',
    }
  );
});

test('classifica CNPJ alfanumérico antes de inferir CPF no login genérico', () => {
  assert.deepEqual(
    buildAuthLoginPayload({
      login: CNPJ_ALFANUMERICO_TRES_LETRAS,
      senha: 'senha-teste',
    }),
    {
      cnpj: CNPJ_ALFANUMERICO_TRES_LETRAS,
      senha: 'senha-teste',
    }
  );
});

test('preserva CPF, CNPJ numérico e e-mail explícitos', () => {
  assert.deepEqual(
    buildAuthLoginPayload({ cpf: '529.982.247-25', senha: 'senha-teste' }),
    { cpf: '52998224725', senha: 'senha-teste' }
  );
  assert.deepEqual(
    buildAuthLoginPayload({ cnpj: '11.222.333/0001-81', senha: 'senha-teste' }),
    { cnpj: '11222333000181', senha: 'senha-teste' }
  );
  assert.deepEqual(
    buildAuthLoginPayload({ email: ' usuario@example.test ', senha: 'senha-teste' }),
    { email: 'usuario@example.test', senha: 'senha-teste' }
  );
});
