import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sql = fs.readFileSync(new URL('../sql/SEO_INDEXNOW_OUTBOX_V138.sql', import.meta.url), 'utf8');

test('V138 protege ambiente e cria estado + outbox persistente', () => {
  assert.match(sql, /MigrationExpectedDatabase/);
  assert.match(sql, /MigrationDryRun/);
  assert.match(sql, /CREATE TABLE dbo\.SeoPerfilEstado/);
  assert.match(sql, /CREATE TABLE dbo\.IndexNowFila/);
  assert.match(sql, /BEGIN TRANSACTION/);
  assert.match(sql, /ROLLBACK/);
});
