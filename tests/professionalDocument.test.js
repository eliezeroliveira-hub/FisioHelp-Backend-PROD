import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROFESSIONAL_PERSON_TYPES,
  normalizeCPF,
  normalizeProfessionalPersonType,
  normalizarDocumentoProfissional,
} from '../utils/professionalDocument.js';
import { calcularDigitosCNPJ } from '../utils/identityValidators.js';

const CPF_VALIDO = '529.982.247-25';
const CNPJ_BASE_NUMERICO = '112223330001';
const CNPJ_NUMERICO = `${CNPJ_BASE_NUMERICO}${calcularDigitosCNPJ(CNPJ_BASE_NUMERICO)}`;
const CNPJ_BASE_ALFANUMERICO = 'AB12CD34EF56';
const CNPJ_ALFANUMERICO = `${CNPJ_BASE_ALFANUMERICO}${calcularDigitosCNPJ(CNPJ_BASE_ALFANUMERICO)}`;

function assertHttpError(fn, message) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, 'HttpError');
    assert.equal(error.statusCode, 400);
    assert.equal(error.message, message);
    return true;
  });
}

test('normaliza CPF formatado e tipo de pessoa sem diferenciar maiúsculas', () => {
  assert.equal(normalizeCPF(CPF_VALIDO), '52998224725');
  assert.equal(normalizeProfessionalPersonType(' pf '), PROFESSIONAL_PERSON_TYPES.PF);
  assert.equal(normalizeProfessionalPersonType('pJ'), PROFESSIONAL_PERSON_TYPES.PJ);
  assert.equal(normalizeProfessionalPersonType('pessoa física'), null);
});

test('resolve cadastro PF explícito com CPF e anula CNPJ', () => {
  assert.deepEqual(
    normalizarDocumentoProfissional({ TipoPessoa: 'PF', CPF: CPF_VALIDO }),
    {
      TipoPessoa: 'PF',
      CPF: '52998224725',
      CNPJ: null,
      DocumentoTipo: 'CPF',
      DocumentoNormalizado: '52998224725',
    }
  );
});

test('infere PF para compatibilidade quando somente CPF é informado', () => {
  const documento = normalizarDocumentoProfissional({ cpf: CPF_VALIDO });
  assert.equal(documento.TipoPessoa, 'PF');
  assert.equal(documento.DocumentoTipo, 'CPF');
});

test('resolve cadastro PJ explícito com CNPJ numérico formatado', () => {
  const formatado = `${CNPJ_NUMERICO.slice(0, 2)}.${CNPJ_NUMERICO.slice(2, 5)}.${CNPJ_NUMERICO.slice(5, 8)}/${CNPJ_NUMERICO.slice(8, 12)}-${CNPJ_NUMERICO.slice(12)}`;
  assert.deepEqual(
    normalizarDocumentoProfissional({ TipoPessoa: 'PJ', CNPJ: formatado }),
    {
      TipoPessoa: 'PJ',
      CPF: null,
      CNPJ: CNPJ_NUMERICO,
      DocumentoTipo: 'CNPJ',
      DocumentoNormalizado: CNPJ_NUMERICO,
    }
  );
});

test('preserva CNPJ alfanumérico válido em caixa alta', () => {
  const documento = normalizarDocumentoProfissional({
    tipoPessoa: 'pj',
    cnpj: CNPJ_ALFANUMERICO.toLowerCase(),
  });
  assert.equal(documento.CNPJ, CNPJ_ALFANUMERICO);
  assert.equal(documento.DocumentoNormalizado, CNPJ_ALFANUMERICO);
});

test('mantém compatibilidade com o cadastro legado que envia somente CNPJ', () => {
  const documento = normalizarDocumentoProfissional({ CNPJ: CNPJ_NUMERICO });
  assert.equal(documento.TipoPessoa, 'PJ');
  assert.equal(documento.CPF, null);
});

test('rejeita TipoPessoa fora do contrato PF/PJ', () => {
  assertHttpError(
    () => normalizarDocumentoProfissional({ TipoPessoa: 'Pessoa Física', CPF: CPF_VALIDO }),
    'TipoPessoa inválido. Informe PF ou PJ.'
  );
});

test('rejeita cadastro sem documento ou com os dois documentos sem tipo', () => {
  assertHttpError(
    () => normalizarDocumentoProfissional({}),
    'Informe exatamente um documento profissional: CPF ou CNPJ.'
  );
  assertHttpError(
    () => normalizarDocumentoProfissional({ CPF: CPF_VALIDO, CNPJ: CNPJ_NUMERICO }),
    'Informe exatamente um documento profissional: CPF ou CNPJ.'
  );
});

test('rejeita documento incompatível com PF', () => {
  assertHttpError(
    () => normalizarDocumentoProfissional({ TipoPessoa: 'PF', CNPJ: CNPJ_NUMERICO }),
    'CPF é obrigatório para fisioterapeuta PF.'
  );
  assertHttpError(
    () => normalizarDocumentoProfissional({ TipoPessoa: 'PF', CPF: CPF_VALIDO, CNPJ: CNPJ_NUMERICO }),
    'Para cadastro como PF, informe somente o CPF.'
  );
});

test('rejeita documento incompatível com PJ', () => {
  assertHttpError(
    () => normalizarDocumentoProfissional({ TipoPessoa: 'PJ', CPF: CPF_VALIDO }),
    'CNPJ é obrigatório para fisioterapeuta PJ.'
  );
  assertHttpError(
    () => normalizarDocumentoProfissional({ TipoPessoa: 'PJ', CPF: CPF_VALIDO, CNPJ: CNPJ_NUMERICO }),
    'Para cadastro como PJ, informe somente o CNPJ.'
  );
});

test('rejeita CPF e CNPJ inválidos', () => {
  assertHttpError(
    () => normalizarDocumentoProfissional({ TipoPessoa: 'PF', CPF: '111.111.111-11' }),
    'CPF inválido.'
  );
  assertHttpError(
    () => normalizarDocumentoProfissional({ TipoPessoa: 'PJ', CNPJ: '00.000.000/0000-00' }),
    'CNPJ inválido.'
  );
});
