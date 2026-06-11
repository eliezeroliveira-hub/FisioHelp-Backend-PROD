// 📁 services/videosService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

const TIPO_VIDEO_BRUTO = 'VIDEO_BRUTO';
const STATUS_PENDENTE = 'Pendente';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function assertId(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} inválido.`);
  return n;
}

function normalizePagination(limitRaw, offsetRaw) {
  const l = Number(limitRaw);
  const o = Number(offsetRaw);
  const limit = Number.isInteger(l) && l > 0 ? Math.min(l, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const offset = Number.isInteger(o) && o >= 0 ? o : 0;
  return { limit, offset };
}

const videosService = {
  /**
   * Registra o upload do vídeo bruto na tabela dbo.DocumentosFisioterapeutas
   * Observação: DataEnvio já tem default (getdate()) no banco.
   */
  async registrarVideoBruto(usuario, { fisioterapeutaId, caminhoRelativo }) {
    const id = assertId(fisioterapeutaId, 'FisioterapeutaId');
    const usuarioId = assertId(usuario?.id, 'Usuário');
    if (!caminhoRelativo) throw new Error('Caminho do arquivo é obrigatório.');
    if (usuarioId !== id) throw new HttpError(403, 'Acesso negado.');

    const result = await queryWithContext(
      usuario,
      (req) => {
        req.input('FisioterapeutaId', sql.Int, id);
        req.input('TipoDocumento', sql.NVarChar(400), TIPO_VIDEO_BRUTO);
        req.input('CaminhoArquivo', sql.NVarChar(1000), caminhoRelativo);
        req.input('Status', sql.NVarChar(60), STATUS_PENDENTE); // CHECK: Pendente/Aprovado/Reprovado
        req.input('FonteValidacao', sql.NVarChar(400), 'Upload App'); // opcional
      },
      `
      DECLARE @Ids TABLE (Id INT);

      INSERT INTO dbo.DocumentosFisioterapeutas
        (FisioterapeutaId, TipoDocumento, CaminhoArquivo, Status, FonteValidacao, ScoreConfianca)
      OUTPUT INSERTED.Id INTO @Ids(Id)
      VALUES
        (@FisioterapeutaId, @TipoDocumento, @CaminhoArquivo, @Status, @FonteValidacao, NULL);

      SELECT TOP 1
        Id,
        FisioterapeutaId,
        TipoDocumento,
        CaminhoArquivo,
        Status,
        DataEnvio,
        DataValidacao,
        ValidadorId,
        MotivoRejeicao,
        FonteValidacao,
        ScoreConfianca
      FROM dbo.DocumentosFisioterapeutas
      WHERE Id = (SELECT TOP 1 Id FROM @Ids);
      `
    );

    return result.recordset?.[0] || null;
  },

  /**
   * Lista os vídeos brutos do próprio fisioterapeuta (últimos 20)
   */
  async listarMeusVideosBrutos(usuario, opts = {}) {
    const id = assertId(usuario?.id, 'Usuário');
    const pag = normalizePagination(opts?.limit, opts?.offset);

    const result = await queryWithContext(
      usuario,
      (req) => {
        req.input('FisioterapeutaId', sql.Int, id);
        req.input('TipoDocumento', sql.NVarChar(400), TIPO_VIDEO_BRUTO);
        req.input('Limit', sql.Int, pag.limit);
        req.input('Offset', sql.Int, pag.offset);
      },
      `
      SELECT COUNT(1) AS TotalRegistros
      FROM dbo.DocumentosFisioterapeutas
      WHERE FisioterapeutaId = @FisioterapeutaId
        AND TipoDocumento = @TipoDocumento;

      SELECT
        Id,
        FisioterapeutaId,
        TipoDocumento,
        CaminhoArquivo,
        Status,
        DataEnvio,
        DataValidacao,
        ValidadorId,
        MotivoRejeicao,
        FonteValidacao,
        ScoreConfianca
      FROM dbo.DocumentosFisioterapeutas
      WHERE FisioterapeutaId = @FisioterapeutaId
        AND TipoDocumento = @TipoDocumento
      ORDER BY ISNULL(DataEnvio, '19000101') DESC, Id DESC
      OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
      `
    );

    const totalRegistros = Number(result?.recordsets?.[0]?.[0]?.TotalRegistros ?? 0);
    const itens = result?.recordsets?.[1] || [];

    return {
      totalRegistros,
      totalNaPagina: itens.length,
      limit: pag.limit,
      offset: pag.offset,
      itens,
    };
  },

  /**
   * Busca um vídeo bruto específico do próprio fisioterapeuta (para visualização/stream)
   */
  async buscarMeuVideoBrutoPorId(usuario, documentoId) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');
    const docId = assertId(documentoId, 'documentoId');

    const result = await queryWithContext(
      usuario,
      (req) => {
        req.input('DocumentoId', sql.Int, docId);
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
        req.input('TipoDocumento', sql.NVarChar(400), TIPO_VIDEO_BRUTO);
      },
      `
      SELECT TOP 1
        Id,
        FisioterapeutaId,
        TipoDocumento,
        CaminhoArquivo,
        Status,
        DataEnvio
      FROM dbo.DocumentosFisioterapeutas
      WHERE Id = @DocumentoId
        AND FisioterapeutaId = @FisioterapeutaId
        AND TipoDocumento = @TipoDocumento;
      `
    );

    return result.recordset?.[0] || null;
  }
};

export default videosService;
