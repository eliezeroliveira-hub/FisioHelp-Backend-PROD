import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  mapAuthLoginResult,
  normalizeAuthUserType,
} from '../utils/authLoginResult.js';

test('normaliza os tipos de usuário aceitos pela autenticação', () => {
  assert.equal(normalizeAuthUserType('administrador'), 'Admin');
  assert.equal(normalizeAuthUserType(' PACIENTE '), 'Paciente');
  assert.equal(normalizeAuthUserType('fisio'), 'Fisioterapeuta');
  assert.equal(normalizeAuthUserType('Fisioterapeuta'), 'Fisioterapeuta');
  assert.equal(normalizeAuthUserType(null), null);
});

test('mapeia paciente retornado pelo login unificado por CPF', () => {
  assert.deepEqual(
    mapAuthLoginResult({
      Tipo: 'Paciente',
      Id: 41,
      Nome: 'Paciente HML',
      Email: 'paciente@example.test',
      SenhaHash: 'hash-paciente',
      Ativo: 1,
      IsBloqueado: 0,
      Cpf: '52998224725',
      Cnpj: null,
    }),
    {
      tipo: 'Paciente',
      id: 41,
      nome: 'Paciente HML',
      email: 'paciente@example.test',
      senhaHash: 'hash-paciente',
      ativo: 1,
      isBloqueado: 0,
      nivelAcesso: null,
      cpf: '52998224725',
      cnpj: null,
    }
  );
});

test('mapeia fisioterapeuta PF sem convertê-lo em paciente', () => {
  const usuario = mapAuthLoginResult({
    Tipo: 'Fisioterapeuta',
    Id: 59,
    Nome: 'Fisioterapeuta PF',
    Email: 'fisio-pf@example.test',
    SenhaHash: 'hash-fisio',
    Ativo: true,
    IsBloqueado: false,
    CPF: '11144477735',
    CNPJ: null,
  });

  assert.equal(usuario.tipo, 'Fisioterapeuta');
  assert.equal(usuario.id, 59);
  assert.equal(usuario.cpf, '11144477735');
  assert.equal(usuario.cnpj, null);
});

test('mantém compatibilidade com fisioterapeuta PJ e aliases legados', () => {
  const usuario = mapAuthLoginResult(
    {
      Id: 2,
      Nome: 'Fisioterapeuta PJ',
      Email: 'fisio-pj@example.test',
      SenhaHash: 'hash-fisio-pj',
      Ativo: 1,
      IsBloqueado: 0,
      CNPJ: '11222333000181',
    },
    { fallbackType: 'Fisioterapeuta' }
  );

  assert.equal(usuario.tipo, 'Fisioterapeuta');
  assert.equal(usuario.cpf, null);
  assert.equal(usuario.cnpj, '11222333000181');
});

test('mapeia admin do login por e-mail preservando nível de acesso', () => {
  const usuario = mapAuthLoginResult({
    Tipo: 'Admin',
    Id: 1,
    Nome: 'Admin HML',
    Email: 'admin@example.test',
    SenhaHash: 'hash-admin',
    Ativo: 1,
    IsBloqueado: 0,
    NivelAcesso: 'Master',
  });

  assert.equal(usuario.tipo, 'Admin');
  assert.equal(usuario.nivelAcesso, 'Master');
});

test('rejeita linha vazia, sem tipo ou com identificador inválido', () => {
  assert.equal(mapAuthLoginResult(null), null);
  assert.equal(mapAuthLoginResult({ Tipo: 'Paciente', Id: 0 }), null);
  assert.equal(mapAuthLoginResult({ Id: 1 }), null);
});

test('authService usa CPF unificado e preserva e-mail, CNPJ e OAuth', () => {
  const source = fs.readFileSync(
    new URL('../services/authService.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /execute\("dbo\.sp_LoginPorCpf_Min"\)/);
  assert.doesNotMatch(source, /execute\("dbo\.sp_LoginPacientePorCpf_Min"\)/);
  assert.match(source, /execute\("dbo\.sp_LoginPorEmail_Min"\)/);
  assert.match(source, /execute\("dbo\.sp_LoginFisioterapeutaPorCnpj_Min"\)/);
  assert.match(source, /async loginOAuth\(/);
});
