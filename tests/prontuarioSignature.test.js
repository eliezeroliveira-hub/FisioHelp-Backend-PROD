import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  criarHashAssinaturaProntuario,
  PRONTUARIO_SIGNATURE_CONTENT_FIELDS,
  PRONTUARIO_SIGNATURE_FIELDS,
  PRONTUARIO_SIGNATURE_VERSION,
} from '../utils/prontuarioSignature.js';

function prontuarioCompleto() {
  return Object.fromEntries(
    PRONTUARIO_SIGNATURE_FIELDS.map((field, index) => [field, `${field}-${index}`])
  );
}

test('hash v2 protege cada campo funcional e metadado da assinatura', () => {
  const base = prontuarioCompleto();
  const original = criarHashAssinaturaProntuario(base);

  assert.equal(original.versao, PRONTUARIO_SIGNATURE_VERSION);
  assert.equal(PRONTUARIO_SIGNATURE_VERSION, 2);
  assert.match(original.hash, /^[a-f0-9]{64}$/);

  for (const field of PRONTUARIO_SIGNATURE_FIELDS) {
    const alterado = { ...base, [field]: `${base[field]}-alterado` };
    assert.notEqual(
      criarHashAssinaturaProntuario(alterado).hash,
      original.hash,
      `alterar ${field} deve alterar o hash`
    );
  }
});

test('datas equivalentes produzem snapshot determinístico', () => {
  const data = '2026-08-04T15:30:00.000Z';
  const comDate = criarHashAssinaturaProntuario({ AssinadoEm: new Date(data) });
  const comIso = criarHashAssinaturaProntuario({ AssinadoEm: data });

  assert.equal(comDate.hash, comIso.hash);
  assert.equal(comDate.snapshot.AssinadoEm, data);
});

test('campos exibidos no PDF estão cobertos pelo conjunto assinado', () => {
  const obrigatorios = [
    'PacienteNomeCompleto',
    'PacienteNaturalidade',
    'PacienteEstadoCivil',
    'PacienteGenero',
    'PacienteLocalNascimento',
    'PacienteDataNascimento',
    'PacienteProfissao',
    'PacienteEnderecoResidencial',
    'PacienteCep',
    'PacienteEnderecoComercial',
    'PacienteCepComercial',
    'QueixaPrincipal',
    'HistoriaClinica',
    'DetalhamentoCaso',
    'PlanoTerapeutico',
    'HabitosDeVida',
    'HistoriaAtual',
    'HistoriaPregressa',
    'AntecedentesPessoais',
    'AntecedentesFamiliares',
    'TratamentosRealizados',
    'ExameClinicoFisico',
    'ExamesComplementares',
    'DiagnosticoFisioterapeutico',
    'PrognosticoFisioterapeutico',
    'PlanoTerapeuticoDetalhado',
    'Evolucao',
    'Intercorrencias',
    'DataCriacao',
    'DataUltimaAtualizacao',
    'DataRegistroProcedimentos',
    'DataEvolucao',
    'ProfissionalNome',
    'ProfissionalCrefito',
  ];

  for (const field of obrigatorios) {
    assert.ok(PRONTUARIO_SIGNATURE_CONTENT_FIELDS.includes(field), `${field} deve estar protegido`);
  }
});

test('service limpa IP nas duas formas de invalidação e usa o hash completo', () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(currentDir, '../services/prontuariosService.js'),
    'utf8'
  );

  assert.equal([...source.matchAll(/IpAssinatura = NULL/g)].length, 2);
  assert.match(source, /criarHashAssinaturaProntuario\(prontuario/);
  assert.match(source, /PacienteCepComercial', 'PacienteCepComercial'/);
  assert.doesNotMatch(source, /createHash\('sha256'\)/);
});
