import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync(
  new URL('../sql/FISIOTERAPEUTA_ELEGIBILIDADE_EMAIL_PUBLICA_V134.sql', import.meta.url),
  'utf8'
);

test('V134 mantém guarda de ambiente, dry-run e transação', () => {
  assert.match(migration, /MigrationExpectedDatabase/);
  assert.match(migration, /MigrationDryRun/);
  assert.match(migration, /BEGIN TRANSACTION/);
  assert.match(migration, /IF @DryRun = 1/);
  assert.match(migration, /ROLLBACK/);
});

test('busca pública exige e-mail verificado nos três caminhos', () => {
  const procedureStart = migration.indexOf('CREATE OR ALTER PROCEDURE [dbo].[SP_Fisioterapeutas_BuscarPublico]');
  const profileStart = migration.indexOf('CREATE OR ALTER PROCEDURE dbo.SP_Fisioterapeuta_PerfilPublico');
  const block = migration.slice(procedureStart, profileStart);

  assert.match(block, /ISNULL\(f\.EmailVerificado, 0\) = 1 -- V134_EMAIL_FISIOS_BASE/);
  assert.equal((block.match(/ISNULL\(fmp\.EmailVerificado, 0\) = 1 -- V134_EMAIL_RESULTADO/g) ?? []).length, 2);
});

test('perfil público direto exige elegibilidade completa', () => {
  const profileStart = migration.indexOf('CREATE OR ALTER PROCEDURE dbo.SP_Fisioterapeuta_PerfilPublico');
  const block = migration.slice(profileStart);

  assert.match(block, /v\.Ativo = 1/);
  assert.match(block, /v\.IsBloqueado = 0/);
  assert.match(block, /v\.CrefitoVerificado = 1/);
  assert.match(block, /ISNULL\(fmp\.EmailVerificado, 0\) = 1; -- V134_EMAIL_PERFIL/);
});
