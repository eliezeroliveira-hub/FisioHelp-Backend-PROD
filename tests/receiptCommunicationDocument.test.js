import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { calcularDigitosCNPJ } from '../utils/identityValidators.js';
import { montarDocumentoProfissionalApresentacao } from '../utils/professionalDocumentPresentation.js';
import { montarEmailNotificacao } from '../services/emailTemplates.js';

const CPF = '52998224725';
const CNPJ_BASE = '112223330001';
const CNPJ = `${CNPJ_BASE}${calcularDigitosCNPJ(CNPJ_BASE)}`;

function dadosEmail(overrides = {}) {
  return {
    consultaId: 321,
    pacienteNome: 'Paciente Teste',
    fisioterapeutaNome: 'Fisioterapeuta Teste',
    fisioterapeutaCrefito: '123456-F',
    dataConsultaTexto: '10/08/2026, 14:00',
    valorTotal: 150,
    enderecoAtendimento: 'Endereço protegido do paciente',
    ...overrides,
  };
}

test('apresenta CPF formatado e rótulo de profissional para PF', () => {
  const documento = montarDocumentoProfissionalApresentacao({
    TipoPessoa: 'PF',
    CPF,
    CNPJ: null,
  });

  assert.deepEqual(documento, {
    tipoPessoa: 'PF',
    documentoTipo: 'CPF',
    documento: CPF,
    rotulo: 'CPF do Profissional',
    valorFormatado: '529.982.247-25',
  });
});

test('apresenta CNPJ formatado e permite adaptar o papel para prestador', () => {
  const documento = montarDocumentoProfissionalApresentacao({
    TipoPessoa: 'PJ',
    CPF: null,
    CNPJ,
  }, { papel: 'Prestador' });

  assert.equal(documento.tipoPessoa, 'PJ');
  assert.equal(documento.documentoTipo, 'CNPJ');
  assert.equal(documento.rotulo, 'CNPJ do Prestador');
  assert.equal(documento.valorFormatado, '11.222.333/0001-81');
});

test('dado legado inconsistente não vaza o valor bruto na apresentação', () => {
  const documento = montarDocumentoProfissionalApresentacao({
    TipoPessoa: 'PF',
    CPF: '111.111.111-11',
  });

  assert.equal(documento.documento, null);
  assert.equal(documento.rotulo, 'CPF/CNPJ do Profissional');
  assert.equal(documento.valorFormatado, 'não informado');
  assert.doesNotMatch(JSON.stringify(documento), /11111111111|111\.111/);
});

test('e-mail de pagamento PF usa CPF no HTML e no texto', () => {
  const email = montarEmailNotificacao({
    dados: {
      tipo: 'pagamento_consulta_confirmado',
      ...dadosEmail({
        fisioterapeutaTipoPessoa: 'PF',
        fisioterapeutaCpf: CPF,
        fisioterapeutaCnpj: null,
      }),
    },
  });

  assert.match(email.corpoHtml, /CPF do Profissional/);
  assert.match(email.corpoHtml, /529\.982\.247-25/);
  assert.match(email.corpoTexto, /CPF do Profissional: 529\.982\.247-25/);
  assert.doesNotMatch(email.corpoHtml, /CNPJ do Profissional/);
  assert.match(email.corpoTexto, /CNPJ 67\.039\.614\/0001-58/);
});

test('e-mail de pagamento PJ mantém CNPJ no HTML e no texto', () => {
  const email = montarEmailNotificacao({
    dados: {
      tipo: 'pagamento_consulta_confirmado',
      ...dadosEmail({
        fisioterapeutaTipoPessoa: 'PJ',
        fisioterapeutaCpf: null,
        fisioterapeutaCnpj: CNPJ,
      }),
    },
  });

  assert.match(email.corpoHtml, /CNPJ do Profissional/);
  assert.match(email.corpoHtml, /11\.222\.333\/0001-81/);
  assert.match(email.corpoTexto, /CNPJ do Profissional: 11\.222\.333\/0001-81/);
  assert.doesNotMatch(email.corpoHtml, /CPF do Profissional/);
});

test('e-mail de cancelamento alterna CPF/CNPJ do prestador', () => {
  const pf = montarEmailNotificacao({
    dados: {
      emailModelo: 'consulta_cancelada_paciente',
      ...dadosEmail({
        fisioterapeutaTipoPessoa: 'PF',
        fisioterapeutaCpf: CPF,
        fisioterapeutaCnpj: null,
      }),
    },
  });
  const pj = montarEmailNotificacao({
    dados: {
      emailModelo: 'consulta_cancelada_paciente',
      ...dadosEmail({
        fisioterapeutaTipoPessoa: 'PJ',
        fisioterapeutaCpf: null,
        fisioterapeutaCnpj: CNPJ,
      }),
    },
  });

  assert.match(pf.corpoHtml, /CPF do Prestador/);
  assert.match(pf.corpoTexto, /CPF do Prestador: 529\.982\.247-25/);
  assert.doesNotMatch(pf.corpoHtml, /CNPJ do Prestador/);

  assert.match(pj.corpoHtml, /CNPJ do Prestador/);
  assert.match(pj.corpoTexto, /CNPJ do Prestador: 11\.222\.333\/0001-81/);
  assert.doesNotMatch(pj.corpoHtml, /CPF do Prestador/);
});

test('dispatcher inclui PF/PJ somente nos dados dos e-mails transacionais', () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(currentDir, '../services/notificacoesDispatch.js'),
    'utf8'
  );

  assert.match(source, /f\.TipoPessoa AS FisioterapeutaTipoPessoa/);
  assert.match(source, /f\.CPF AS FisioterapeutaCpf/);
  assert.equal(
    [...source.matchAll(/fisioterapeutaTipoPessoa:\s*consulta\.FisioterapeutaTipoPessoa/g)].length,
    2
  );
  assert.equal(
    [...source.matchAll(/fisioterapeutaCpf:\s*consulta\.FisioterapeutaCpf/g)].length,
    2
  );

  const pushPagamento = source.match(
    /const payload = dadosBase\('pagamento_consulta_confirmado',[\s\S]*?\n\s*\}\);/
  )?.[0] || '';
  const emailPagamento = source.match(
    /const emailDados = dadosBase\('pagamento_consulta_confirmado',[\s\S]*?\n\s*\}\);/
  )?.[0] || '';

  assert.doesNotMatch(pushPagamento, /fisioterapeutaCpf|fisioterapeutaCnpj/);
  assert.match(emailPagamento, /fisioterapeutaCpf/);
  assert.match(emailPagamento, /fisioterapeutaCnpj/);
});

test('os dois PDFs renderizam o documento dinâmico e as consultas privadas retornam contrato PF/PJ', () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(currentDir, '../services/recibosService.js'),
    'utf8'
  );

  assert.equal(
    [...source.matchAll(/fieldRow\(documentoProfissional\.rotulo, documentoProfissional\.valorFormatado\)/g)].length,
    2
  );
  assert.match(source, /f\.TipoPessoa AS FisioterapeutaTipoPessoa/);
  assert.match(source, /f\.CPF AS FisioterapeutaCpf/);
  assert.equal(
    [...source.matchAll(/AS FisioterapeutaDocumentoTipo/g)].length,
    1
  );
  assert.equal(
    [...source.matchAll(/AS FisioterapeutaDocumento,/g)].length,
    1
  );
  const listagem = source.match(/async listar\(usuario\)[\s\S]*?async detalhar\(usuario, reciboId\)/)?.[0] || '';
  assert.doesNotMatch(listagem, /FisioterapeutaDocumento|FisioterapeutaCnpj|FisioterapeutaCpf/);
  assert.doesNotMatch(source, /fieldRow\('CNPJ do Profissional'/);
});

test('rotas de recibo continuam restritas a paciente autenticado', () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.resolve(currentDir, '../routes/recibos.js'),
    'utf8'
  );

  assert.equal(
    [...source.matchAll(/verificarPermissao\(\['Paciente'\]\)/g)].length,
    3
  );
});
