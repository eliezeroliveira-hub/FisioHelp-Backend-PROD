import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

const service = readProjectFile('services/adminAnalyticsService.js');
const routes = readProjectFile('routes/adminAnalytics.js');
const methodStart = service.indexOf('  async distribuicaoRegional(usuario) {');
const methodEnd = service.indexOf('  retencaoPacientes(usuario, f)', methodStart);
const method = service.slice(methodStart, methodEnd);

test('rota regional usa o grupo protegido de usuários e chama o método dedicado', () => {
  assert.match(
    routes,
    /router\.use\(\s*\['\/usuarios',[\s\S]*?requireAdminPagePermission\('relatorios-plataforma'\)/
  );
  assert.match(
    routes,
    /router\.get\('\/usuarios\/distribuicao-regional',\s*wrap\(\(req\)\s*=>\s*call\('distribuicaoRegional',\s*req,\s*req\.query\)\)\)/
  );
});

test('serviço exige usuário Admin e consulta com contexto administrativo', () => {
  assert.ok(methodStart >= 0 && methodEnd > methodStart);
  assert.match(method, /String\(usuario\?\.tipo \|\| ''\)\.toLowerCase\(\) !== 'admin'/);
  assert.match(method, /queryWithContext\(\s*usuario,/);
});

test('data de referência da idade usa o fuso da aplicação e parâmetro SQL Date', () => {
  assert.match(service, /import \{ agoraAppDate \} from '\.\.\/utils\/appDateTime\.js';/);
  assert.match(method, /request\.input\('DataHoje', sql\.Date, agoraAppDate\(\)\)/);
  assert.match(method, /DATEDIFF\(YEAR, CONVERT\(DATE, p\.DataNascimento\), @DataHoje\)/);
  assert.match(method, /DATEADD\([\s\S]*?YEAR,[\s\S]*?p\.DataNascimento[\s\S]*?\) > @DataHoje/);
  assert.match(method, /p\.DataNascimento IS NULL OR CONVERT\(DATE, p\.DataNascimento\) > @DataHoje THEN NULL/);
});

test('materializa os conjuntos regionais para reutilização consistente nos quatro resultados', () => {
  assert.match(
    method,
    /IF OBJECT_ID\('tempdb\.\.#FisioterapeutasBase'\) IS NOT NULL\s+DROP TABLE #FisioterapeutasBase/
  );
  assert.match(
    method,
    /IF OBJECT_ID\('tempdb\.\.#PacientesBase'\) IS NOT NULL\s+DROP TABLE #PacientesBase/
  );
  assert.match(method, /INTO #FisioterapeutasBase/);
  assert.match(method, /INTO #PacientesBase/);
  assert.ok((method.match(/FROM #FisioterapeutasBase/g) || []).length >= 2);
  assert.ok((method.match(/FROM #PacientesBase/g) || []).length >= 2);
});

test('agrupa cidade e estado sem descartar localizações ausentes', () => {
  assert.match(method, /UPPER\(LTRIM\(RTRIM\(f\.Estado\)\)\)/);
  assert.match(method, /LTRIM\(RTRIM\(f\.Cidade\)\)/);
  assert.match(method, /UPPER\(LTRIM\(RTRIM\(p\.Estado\)\)\)/);
  assert.match(method, /LTRIM\(RTRIM\(p\.Cidade\)\)/);
  assert.ok((method.match(/N'Não informado'/g) || []).length >= 4);
  assert.ok((method.match(/GROUP BY Estado, Cidade/g) || []).length >= 2);
});

test('separa ativos, bloqueados e inativos sem dupla contagem', () => {
  assert.match(method, /ISNULL\(f\.Ativo, 0\) = 1 AND ISNULL\(f\.IsBloqueado, 0\) = 0/);
  assert.match(method, /ISNULL\(f\.IsBloqueado, 0\) = 1/);
  assert.match(method, /ISNULL\(f\.Ativo, 0\) = 0 AND ISNULL\(f\.IsBloqueado, 0\) = 0/);
  assert.match(method, /ISNULL\(p\.Ativo, 0\) = 1 AND ISNULL\(p\.IsBloqueado, 0\) = 0/);
  assert.match(method, /CrefitoVerificados = COALESCE\(SUM\(CrefitoVerificado\), 0\)/);
});

test('retorno é agregado e não projeta identificadores pessoais', () => {
  assert.match(method, /IdadeMedia = CAST\(ROUND\(AVG\(CAST\(Idade AS DECIMAL\(10, 2\)\)\), 1\)/);
  assert.match(method, /PacientesComIdadeInformada = COUNT\(Idade\)/);
  assert.doesNotMatch(method, /\bCPF\b|\bCNPJ\b|\bEmail\b|\bTelefone\b|\bNome\b|\bCREFITO\b/);
  assert.match(method, /fisioterapeutas: result\.recordsets\?\.\[2\] \?\? \[\]/);
  assert.match(method, /pacientes: result\.recordsets\?\.\[3\] \?\? \[\]/);
});
