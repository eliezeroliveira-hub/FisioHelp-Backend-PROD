import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync(
  new URL('../sql/CALENDARIO_FISIO_PERFORMANCE_V137.sql', import.meta.url),
  'utf8'
);
const procedureBody = migration.slice(migration.indexOf('CREATE OR ALTER PROCEDURE'));

test('V137 protege ambiente, suporta dry-run e exige a definição anterior esperada', () => {
  assert.match(migration, /MigrationExpectedDatabase/);
  assert.match(migration, /MigrationDryRun/);
  assert.match(migration, /DB_NAME\(\) NOT IN \(N'mvpdb-hml', N'FisioHelp_PROD'\)/);
  assert.match(migration, /BEGIN TRANSACTION/);
  assert.match(migration, /IF @DryRun = 1/);
  assert.match(migration, /ROLLBACK/);
});

test('V137 usa tally determinístico de 48 posições e datetime nativo', () => {
  assert.match(procedureBody, /V137_TALLY_48/);
  assert.doesNotMatch(procedureBody, /FROM sys\.all_objects/);
  assert.match(procedureBody, /\(46\),\(47\)/);
  assert.match(procedureBody, /V137_NATIVE_DATETIME/);
  assert.match(procedureBody, /DATEDIFF\(SECOND/);
  assert.doesNotMatch(procedureBody, /CONVERT\(varchar\(10\)/i);
});

test('V137 preserva contrato, regras e restauração de RLS nos dois caminhos', () => {
  assert.match(procedureBody, /@FisioterapeutaId INT/);
  assert.match(procedureBody, /@Ano SMALLINT/);
  assert.match(procedureBody, /@Mes TINYINT/);
  assert.match(procedureBody, /@DuracaoMin TINYINT = 60/);
  assert.match(procedureBody, /LTRIM\(RTRIM\(ISNULL\(c\.Status/);
  assert.match(procedureBody, /V137_RLS_RESTORE_SUCCESS/);
  assert.match(procedureBody, /V137_RLS_RESTORE_CATCH/);
  assert.match(procedureBody, /EXEC sys\.sp_set_session_context @key = N''UsuarioTipo'', @value = @OrigTipo/);
  assert.match(procedureBody, /EXEC sys\.sp_set_session_context @key = N''UsuarioId'',\s+@value = @OrigId/);
  assert.match(procedureBody, /OPTION \(MAXRECURSION 370\)/);
});
