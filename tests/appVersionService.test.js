import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compararVersoes,
  obterStatusVersaoApp,
} from '../services/appVersionService.js';

const ENV_TESTE = {
  MOBILE_ANDROID_UPDATE_MODE: 'required',
  MOBILE_ANDROID_MIN_VERSION: '1.0.3',
  MOBILE_ANDROID_MIN_BUILD: 8,
  MOBILE_ANDROID_STORE_URL:
    'https://play.google.com/store/apps/details?id=br.com.fisiohelp.app&pli=1',
  MOBILE_IOS_UPDATE_MODE: 'off',
  MOBILE_IOS_MIN_VERSION: '1.0.3',
  MOBILE_IOS_MIN_BUILD: 7,
  MOBILE_IOS_STORE_URL:
    'https://apps.apple.com/br/app/fisiohelp/id6794336661',
};

test('compararVersoes trata segmentos numericamente', () => {
  assert.equal(compararVersoes('1.0.10', '1.0.9'), 1);
  assert.equal(compararVersoes('1.0.2', '1.0.3'), -1);
  assert.equal(compararVersoes('1.0.3', '1.0.3.0'), 0);
});

test('Android exige atualização quando a versão é inferior', () => {
  const status = obterStatusVersaoApp(
    { plataforma: 'android', versao: '1.0.2', build: '99' },
    ENV_TESTE
  );

  assert.equal(status.atualizacaoObrigatoria, true);
  assert.equal(status.versaoMinima, '1.0.3');
  assert.match(status.lojaUrl, /play\.google\.com/);
});

test('Android exige atualização pelo build quando a versão é igual', () => {
  const status = obterStatusVersaoApp(
    { plataforma: 'android', versao: '1.0.3', build: '7' },
    ENV_TESTE
  );

  assert.equal(status.atualizacaoObrigatoria, true);
});

test('Android libera versão e build mínimos', () => {
  const status = obterStatusVersaoApp(
    { plataforma: 'android', versao: '1.0.3', build: '8' },
    ENV_TESTE
  );

  assert.equal(status.atualizacaoObrigatoria, false);
});

test('Build mínimo não bloqueia uma versão superior', () => {
  const status = obterStatusVersaoApp(
    { plataforma: 'android', versao: '1.0.4', build: '1' },
    ENV_TESTE
  );

  assert.equal(status.atualizacaoObrigatoria, false);
});

test('Modo off nunca bloqueia', () => {
  const status = obterStatusVersaoApp(
    { plataforma: 'ios', versao: '1.0.1', build: '1' },
    ENV_TESTE
  );

  assert.equal(status.atualizacaoObrigatoria, false);
  assert.equal(
    status.lojaUrl,
    'https://apps.apple.com/br/app/fisiohelp/id6794336661'
  );
});

test('Rejeita plataforma inválida', () => {
  assert.throws(
    () =>
      obterStatusVersaoApp(
        { plataforma: 'windows', versao: '1.0.3', build: '8' },
        ENV_TESTE
      ),
    /Plataforma inválida/
  );
});

test('Rejeita versão inválida', () => {
  assert.throws(
    () =>
      obterStatusVersaoApp(
        { plataforma: 'android', versao: 'versao-atual', build: '8' },
        ENV_TESTE
      ),
    /Versão atual inválida/
  );
});

test('Rejeita build inválido', () => {
  assert.throws(
    () =>
      obterStatusVersaoApp(
        { plataforma: 'android', versao: '1.0.3', build: '-1' },
        ENV_TESTE
      ),
    /Build inválido/
  );
});
