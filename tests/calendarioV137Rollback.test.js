import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const rollback = fs.readFileSync(
  new URL('../sql/CALENDARIO_FISIO_PERFORMANCE_V137_ROLLBACK.sql', import.meta.url),
  'utf8'
);

test('rollback V137 exige banco esperado e procedure V137 ativa', () => {
  assert.match(rollback, /MigrationExpectedDatabase/);
  assert.match(rollback, /MigrationDryRun/);
  assert.match(rollback, /V137_TALLY_48/);
  assert.match(rollback, /V137_NATIVE_DATETIME/);
  assert.match(rollback, /V137_RLS_RESTORE_SUCCESS/);
  assert.match(rollback, /V137_RLS_RESTORE_CATCH/);
});

test('rollback V137 restaura o gerador e as regras anteriores', () => {
  assert.match(rollback, /FROM sys\.all_objects o1/);
  assert.match(rollback, /CROSS JOIN sys\.all_objects o2/);
  assert.match(rollback, /SELECT TOP \(2000\)/);
  assert.match(rollback, /CONVERT\(varchar\(10\), b\.DataRef, 23\)/);
  assert.match(rollback, /LTRIM\(RTRIM\(ISNULL\(c\.Status/);
  assert.match(rollback, /OPTION \(MAXRECURSION 370\)/);
});

test('rollback V137 e transacional, validavel e preserva a restauracao do contexto', () => {
  assert.match(rollback, /BEGIN TRANSACTION/);
  assert.match(rollback, /IF @DryRun = 1/);
  assert.match(rollback, /ROLLBACK/);
  assert.match(rollback, /EXEC sys\.sp_set_session_context @key = N''UsuarioTipo'', @value = @OrigTipo/);
  assert.match(rollback, /EXEC sys\.sp_set_session_context @key = N''UsuarioId'',\s+@value = @OrigId/);
  assert.match(rollback, /BEGIN CATCH[\s\S]*THROW;/);
});
