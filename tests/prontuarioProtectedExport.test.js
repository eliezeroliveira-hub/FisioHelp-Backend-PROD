import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_USER ||= 'test';
process.env.DB_PASS ||= 'test';
process.env.DB_SERVER ||= 'localhost';
process.env.DB_NAME ||= 'test';
process.env.JWT_SECRET ||= 'test-secret';

const { gerarPdfBuffer } = await import('../services/prontuariosService.js');

const prontuario = {
  Id: 123,
  PacienteId: 456,
  FisioterapeutaId: 789,
  PacienteNomeCompleto: 'Paciente de Teste',
  ProfissionalNome: 'Profissional de Teste',
  ProfissionalCrefito: '12345-F',
  QueixaPrincipal: 'Teste de exportação protegida.',
  DataCriacao: new Date('2026-10-30T12:00:00.000Z'),
  DataUltimaAtualizacao: new Date('2026-10-30T12:00:00.000Z'),
};

test('gerador padrão permanece compatível e sem senha', async () => {
  const buffer = await gerarPdfBuffer(prontuario);
  assert.equal(Buffer.isBuffer(buffer), true);
  assert.equal(buffer.subarray(0, 4).toString('ascii'), '%PDF');
  assert.equal(buffer.includes(Buffer.from('/Encrypt')), false);
});

test('exportação de encerramento usa AES-256 e senha do usuário', async () => {
  const buffer = await gerarPdfBuffer(prontuario, {
    pdfVersion: '1.7ext3',
    userPassword: '12345678901',
    ownerPassword: 'owner-password-aleatoria-e-nao-persistida',
    permissions: {
      printing: 'highResolution',
      modifying: false,
      copying: false,
      annotating: false,
      fillingForms: false,
      contentAccessibility: true,
      documentAssembly: false,
    },
  });
  assert.equal(buffer.subarray(0, 4).toString('ascii'), '%PDF');
  assert.equal(buffer.includes(Buffer.from('/Encrypt')), true);
});
