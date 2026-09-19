import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOAuthAudiences,
  tokenHasAllowedAudience,
  verificationAudience,
} from '../utils/oauthAudiences.js';

test('compõe audiências legadas e múltiplas sem duplicação', () => {
  assert.deepEqual(
    buildOAuthAudiences(
      'br.com.fisiohelp.app.hml',
      'br.com.fisiohelp.app.hml, br.com.fisiohelp.web.hml;extra.example'
    ),
    ['br.com.fisiohelp.app.hml', 'br.com.fisiohelp.web.hml', 'extra.example']
  );
});

test('usa string para uma audiência e array para múltiplas', () => {
  assert.equal(verificationAudience(['one.example']), 'one.example');
  assert.deepEqual(verificationAudience(['one.example', 'two.example']), ['one.example', 'two.example']);
});

test('aceita somente audiências presentes na lista permitida', () => {
  const allowed = ['br.com.fisiohelp.app.hml', 'br.com.fisiohelp.web.hml'];

  assert.equal(tokenHasAllowedAudience('br.com.fisiohelp.app.hml', allowed), true);
  assert.equal(tokenHasAllowedAudience(['unknown.example', 'br.com.fisiohelp.web.hml'], allowed), true);
  assert.equal(tokenHasAllowedAudience('br.com.fisiohelp.app', allowed), false);
  assert.equal(tokenHasAllowedAudience(null, allowed), false);
});
