// services/fisioPacientesService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';
import path from 'path';

function isFisio(usuario) {
  return String(usuario?.tipo || '').toLowerCase() === 'fisioterapeuta';
}

function assertUser(usuario) {
  if (!usuario?.id || !usuario?.tipo) throw new HttpError(401, 'Não autenticado.');
}

function assertInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} inválido.`);
  return n;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeQueryText(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s.slice(0, 200) : null;
}

function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

// Status considerados "atendidos" para listar pacientes do fisio
// Ajuste conforme sua regra (p.ex: incluir 'Confirmada' e/ou apenas 'Concluída')
const STATUS_ATENDIDOS = ['Confirmada', 'Concluída'];

const fisioPacientesService = {
  /**
   * Lista pacientes vinculados ao fisio logado.
   * GET /fisio/pacientes?q=...&limit=...&offset=...
   *
   * Inclui pacientes da carteira e também pacientes já atendidos,
   * mesmo quando não houver vínculo ativo na carteira.
   */
  async listarPacientesAtendidos(usuario, { q, limit = 50, offset = 0 } = {}) {
    assertUser(usuario);
    if (!isFisio(usuario)) throw new HttpError(403, 'Acesso negado.');

    const fisioterapeutaId = assertInt(usuario.id, 'Usuário');
    const texto = normalizeQueryText(q);
    const textoPrefixo = texto ? `${texto}%` : null;
    const qDigits = texto ? onlyDigits(texto) : '';
    const qDigitsPrefixo = qDigits ? `${qDigits}%` : null;

    const lim = clamp(Number(limit) || 50, 1, 200);
    const off = Math.max(0, Number(offset) || 0);

    const status1 = STATUS_ATENDIDOS[0] || 'Confirmada';
    const status2 = STATUS_ATENDIDOS[1] || 'Concluída';

    const result = await queryWithContext(
      usuario,
      (req) => {
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
        req.input('Q', sql.NVarChar(200), texto);
        req.input('QPrefixo', sql.NVarChar(201), textoPrefixo);
        req.input('QDigits', sql.NVarChar(40), qDigits || null);
        req.input('QDigitsPrefixo', sql.NVarChar(41), qDigitsPrefixo);
        req.input('Limit', sql.Int, lim);
        req.input('Offset', sql.Int, off);

        // status via parâmetros (evita string SQL "hardcode")
        req.input('Status1', sql.NVarChar(60), status1);
        req.input('Status2', sql.NVarChar(60), status2);
      },
      `
      ;WITH Base AS (
        SELECT
          p.Id,
          p.Nome,
          p.CPF,
          p.CPFValido,
          p.EmailVerificado,
          p.TelefoneVerificado,
          p.Cep AS CEP,
          p.CepComercial,
          p.Estado,
          p.Cidade,
          p.BairroResidencial,
          p.BairroComercial,
          p.EnderecoComercial,
          p.EnderecoResidencial,
          p.ComplementoComercial,
          p.ComplementoResidencial,
          p.Email
        FROM dbo.FisioPacientesCarteira fpc
        INNER JOIN dbo.Pacientes p
          ON p.Id = fpc.PacienteId
        WHERE fpc.FisioterapeutaId = @FisioterapeutaId
          AND fpc.Ativo = 1

        UNION

        SELECT
          p.Id,
          p.Nome,
          p.CPF,
          p.CPFValido,
          p.EmailVerificado,
          p.TelefoneVerificado,
          p.Cep AS CEP,
          p.CepComercial,
          p.Estado,
          p.Cidade,
          p.BairroResidencial,
          p.BairroComercial,
          p.EnderecoComercial,
          p.EnderecoResidencial,
          p.ComplementoComercial,
          p.ComplementoResidencial,
          p.Email
        FROM dbo.Consultas c
        INNER JOIN dbo.Pacientes p
          ON p.Id = c.PacienteId
        WHERE c.FisioterapeutaId = @FisioterapeutaId
          AND c.Status IN (@Status1, @Status2)
      ),
      BaseFinal AS (
        SELECT
          b.Id,
          b.Nome,
          b.CPF,
          b.CPFValido,
          b.EmailVerificado,
          b.TelefoneVerificado,
          b.CEP,
          b.CepComercial,
          b.Estado,
          b.Cidade,
          b.BairroResidencial,
          b.BairroComercial,
          b.EnderecoComercial,
          b.EnderecoResidencial,
          b.ComplementoComercial,
          b.ComplementoResidencial,
          b.Email,
          MAX(c.DataHora) AS UltimaConsulta,
          COUNT(c.Id) AS QtdeConsultas
        FROM Base b
        LEFT JOIN dbo.Consultas c
          ON c.PacienteId = b.Id
         AND c.FisioterapeutaId = @FisioterapeutaId
         AND c.Status IN (@Status1, @Status2)
        WHERE (
            @Q IS NULL
            OR b.Nome LIKE @QPrefixo
            OR b.Email LIKE @QPrefixo
            OR (@QDigits IS NOT NULL AND (
              b.CPF = @QDigits
              OR b.CPF LIKE @QDigitsPrefixo
            ))
          )
        GROUP BY
          b.Id,
          b.Nome,
          b.CPF,
          b.CPFValido,
          b.EmailVerificado,
          b.TelefoneVerificado,
          b.CEP,
          b.CepComercial,
          b.Estado,
          b.Cidade,
          b.BairroResidencial,
          b.BairroComercial,
          b.EnderecoComercial,
          b.EnderecoResidencial,
          b.ComplementoComercial,
          b.ComplementoResidencial,
          b.Email
      )
      SELECT COUNT(1) AS Total
      FROM BaseFinal;

      ;WITH Base AS (
        SELECT
          p.Id,
          p.Nome,
          p.CPF,
          p.CPFValido,
          p.EmailVerificado,
          p.TelefoneVerificado,
          p.Cep AS CEP,
          p.CepComercial,
          p.Estado,
          p.Cidade,
          p.BairroResidencial,
          p.BairroComercial,
          p.EnderecoComercial,
          p.EnderecoResidencial,
          p.ComplementoComercial,
          p.ComplementoResidencial,
          p.Email
        FROM dbo.FisioPacientesCarteira fpc
        INNER JOIN dbo.Pacientes p
          ON p.Id = fpc.PacienteId
        WHERE fpc.FisioterapeutaId = @FisioterapeutaId
          AND fpc.Ativo = 1

        UNION

        SELECT
          p.Id,
          p.Nome,
          p.CPF,
          p.CPFValido,
          p.EmailVerificado,
          p.TelefoneVerificado,
          p.Cep AS CEP,
          p.CepComercial,
          p.Estado,
          p.Cidade,
          p.BairroResidencial,
          p.BairroComercial,
          p.EnderecoComercial,
          p.EnderecoResidencial,
          p.ComplementoComercial,
          p.ComplementoResidencial,
          p.Email
        FROM dbo.Consultas c
        INNER JOIN dbo.Pacientes p
          ON p.Id = c.PacienteId
        WHERE c.FisioterapeutaId = @FisioterapeutaId
          AND c.Status IN (@Status1, @Status2)
      ),
      BaseFinal AS (
        SELECT
          b.Id,
          b.Nome,
          b.CPF,
          b.CPFValido,
          b.EmailVerificado,
          b.TelefoneVerificado,
          b.CEP,
          b.CepComercial,
          b.Estado,
          b.Cidade,
          b.BairroResidencial,
          b.BairroComercial,
          b.EnderecoComercial,
          b.EnderecoResidencial,
          b.ComplementoComercial,
          b.ComplementoResidencial,
          b.Email,
          MAX(c.DataHora) AS UltimaConsulta,
          COUNT(c.Id) AS QtdeConsultas
        FROM Base b
        LEFT JOIN dbo.Consultas c
          ON c.PacienteId = b.Id
         AND c.FisioterapeutaId = @FisioterapeutaId
         AND c.Status IN (@Status1, @Status2)
        WHERE (
            @Q IS NULL
            OR b.Nome LIKE @QPrefixo
            OR b.Email LIKE @QPrefixo
            OR (@QDigits IS NOT NULL AND (
              b.CPF = @QDigits
              OR b.CPF LIKE @QDigitsPrefixo
            ))
          )
        GROUP BY
          b.Id,
          b.Nome,
          b.CPF,
          b.CPFValido,
          b.EmailVerificado,
          b.TelefoneVerificado,
          b.CEP,
          b.CepComercial,
          b.Estado,
          b.Cidade,
          b.BairroResidencial,
          b.BairroComercial,
          b.EnderecoComercial,
          b.EnderecoResidencial,
          b.ComplementoComercial,
          b.ComplementoResidencial,
          b.Email
      )
      SELECT
        Id,
        Nome,
        CPF,
        CPFValido,
        EmailVerificado,
        TelefoneVerificado,
        CASE
          WHEN ISNULL(CPFValido, 0) = 1
           AND ISNULL(EmailVerificado, 0) = 1
           AND ISNULL(TelefoneVerificado, 0) = 1
            THEN CAST(1 AS bit)
          ELSE CAST(0 AS bit)
        END AS ContaVerificada,
        CEP,
        CepComercial,
        Estado,
        Cidade,
        BairroResidencial,
        BairroComercial,
        EnderecoComercial,
        EnderecoResidencial,
        ComplementoComercial,
        ComplementoResidencial,
        Email,
        UltimaConsulta,
        QtdeConsultas
      FROM BaseFinal
      ORDER BY COALESCE(UltimaConsulta, '19000101') DESC, Nome ASC
      OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `
    );

    return {
      total: result?.recordsets?.[0]?.[0]?.Total ?? 0,
      limit: lim,
      offset: off,
      itens: result?.recordsets?.[1] || []
    };
  },

  async listarPedidosMedicosPacientes(usuario, { limit = 50, offset = 0 } = {}) {
    assertUser(usuario);
    if (!isFisio(usuario)) throw new HttpError(403, 'Acesso negado.');

    const fisioterapeutaId = assertInt(usuario.id, 'Usuário');
    const lim = clamp(Number(limit) || 50, 1, 200);
    const off = Math.max(0, Number(offset) || 0);

    const result = await queryWithContext(
      usuario,
      (req) => {
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
        req.input('Limit', sql.Int, lim);
        req.input('Offset', sql.Int, off);
      },
      `
      ;WITH Base AS (
        SELECT
          dp.Id AS DocumentoPacienteId,
          dp.PacienteId,
          dp.ConsultaId,
          dp.TipoDocumento,
          dp.CaminhoArquivo,
          c.DataHora AS DataConsulta,
          c.Status AS StatusConsulta,
          p.Nome AS NomePaciente
        FROM dbo.DocumentosPacientes dp
        INNER JOIN dbo.Consultas c
          ON c.Id = dp.ConsultaId
        INNER JOIN dbo.Pacientes p
          ON p.Id = dp.PacienteId
        WHERE c.FisioterapeutaId = @FisioterapeutaId
          AND dp.TipoDocumento = N'AutorizacaoAtendimento'
      )
      SELECT COUNT(1) AS Total
      FROM Base;

      ;WITH Base AS (
        SELECT
          dp.Id AS DocumentoPacienteId,
          dp.PacienteId,
          dp.ConsultaId,
          dp.TipoDocumento,
          dp.CaminhoArquivo,
          c.DataHora AS DataConsulta,
          c.Status AS StatusConsulta,
          p.Nome AS NomePaciente
        FROM dbo.DocumentosPacientes dp
        INNER JOIN dbo.Consultas c
          ON c.Id = dp.ConsultaId
        INNER JOIN dbo.Pacientes p
          ON p.Id = dp.PacienteId
        WHERE c.FisioterapeutaId = @FisioterapeutaId
          AND dp.TipoDocumento = N'AutorizacaoAtendimento'
      )
      SELECT
        DocumentoPacienteId,
        PacienteId,
        ConsultaId,
        TipoDocumento,
        CaminhoArquivo,
        DataConsulta,
        StatusConsulta,
        NomePaciente
      FROM Base
      ORDER BY
        CASE WHEN DataConsulta IS NULL THEN 1 ELSE 0 END ASC,
        DataConsulta DESC,
        DocumentoPacienteId DESC
      OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `,
      { requireContext: true }
    );

    const itens = (result?.recordsets?.[1] || []).map((doc) => {
      const documentoPacienteId = Number(doc.DocumentoPacienteId) || null;
      const caminhoArquivo = doc.CaminhoArquivo ? String(doc.CaminhoArquivo).trim() : '';
      const nomeArquivo = caminhoArquivo
        ? path.basename(caminhoArquivo)
        : `pedido-medico-${documentoPacienteId ?? 'arquivo'}.pdf`;

      return {
        DocumentoPacienteId: documentoPacienteId,
        PacienteId: Number(doc.PacienteId) || null,
        ConsultaId: Number(doc.ConsultaId) || null,
        NomePaciente: doc.NomePaciente ?? null,
        DataConsulta: doc.DataConsulta ?? null,
        StatusConsulta: doc.StatusConsulta ?? null,
        TipoDocumento: doc.TipoDocumento ?? null,
        NomeArquivo: nomeArquivo,
        VisualizarUrl: documentoPacienteId
          ? `/api/arquivos/pedidos-medicos/${documentoPacienteId}/visualizar`
          : null,
        DownloadUrl: documentoPacienteId
          ? `/api/arquivos/pedidos-medicos/${documentoPacienteId}/download`
          : null,
      };
    });

    return {
      total: result?.recordsets?.[0]?.[0]?.Total ?? 0,
      limit: lim,
      offset: off,
      itens,
    };
  },
};

export { HttpError };
export default fisioPacientesService;
