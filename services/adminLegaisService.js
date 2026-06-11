// 📁 services/adminLegaisService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

function asTipo(u) {
  return String(u?.tipo || '').toLowerCase();
}

function requireAdmin(usuario) {
  if (!usuario?.id || !usuario?.tipo) throw new HttpError(401, 'Não autenticado.');
  if (asTipo(usuario) !== 'admin') throw new HttpError(403, 'Acesso negado.');
}

// Normaliza para constraint da tabela: Termos | Privacidade
function normalizarTipo(tipo) {
  if (tipo === undefined || tipo === null) return null;
  const s = String(tipo).trim();
  if (!s) return null;

  const key = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s-]+/g, '_');

  // Tipos suportados (DocumentosLegais.Tipo)
  // - Termos
  // - Privacidade
  // - CancelamentoReembolso  (política de cancelamento/reembolso mostrada antes do pagamento)
  const mapa = {
    termos: 'Termos',
    termo: 'Termos',
    termo_de_uso: 'Termos',
    termos_de_uso: 'Termos',

    privacidade: 'Privacidade',
    politica_de_privacidade: 'Privacidade',
    politica_privacidade: 'Privacidade',

    // Política de cancelamento/reembolso
    cancelamentoreembolso: 'CancelamentoReembolso',
    cancelamento_reembolso: 'CancelamentoReembolso',
    politica_de_cancelamento_reembolso: 'CancelamentoReembolso',
    politica_cancelamento_reembolso: 'CancelamentoReembolso',
    politica_de_cancelamento: 'CancelamentoReembolso',
    politica_cancelamento: 'CancelamentoReembolso',
    cancelamento: 'CancelamentoReembolso',
    reembolso: 'CancelamentoReembolso'
  };

  const out = mapa[key];
  if (!out) {
    throw new HttpError(400, 'Tipo inválido. Use "Termos", "Privacidade" ou "CancelamentoReembolso".');
  }
  return out;
}

function mapLegaisDbError(err) {
  const msg = String(err?.message || '');

  if (
    msg.includes('já foi publicado/ativado')
    || msg.includes('só é permitido editar rascunhos')
    || msg.includes('versão já existe')
    || msg.includes('versao já existe')
    || msg.includes('já existe um documento')
    || msg.includes('possui aceites vinculados')
    || msg.includes('nunca foi publicado')
  ) {
    return new HttpError(409, msg || 'Conflito de regra de negócio.');
  }

  if (msg.includes('não encontrado') || msg.includes('nao encontrado')) {
    return new HttpError(404, msg || 'Documento legal não encontrado.');
  }

  if (Number(err?.number) === 547) {
    return new HttpError(409, 'Operação não permitida por vínculo de integridade referencial.');
  }

  return null;
}

const adminLegaisService = {
  /**
   * Lista versões (rascunhos/publicados/arquivados) direto da dbo.DocumentosLegais.
   * Retorna metadados (sem Conteudo).
   */
  async listarVersoes(usuario, { tipo } = {}) {
    requireAdmin(usuario);

    const tipoNorm = tipo ? normalizarTipo(tipo) : null;

    const result = await queryWithContext(usuario, (req) => {
      req.input('Tipo', sql.NVarChar(80), tipoNorm);
    }, `
      IF OBJECT_ID('dbo.DocumentosLegais', 'U') IS NULL
        THROW 50000, 'Infraestrutura de documentos legais indisponível.', 1;

      SELECT
        Id,
        Tipo,
        Versao,
        Titulo,
        Ativo,
        PublicadoEm,
        CriadoPorAdminId,
        CriadoEm,
        AtualizadoEm,
        CASE
          WHEN PublicadoEm IS NULL AND Ativo = 0 THEN 'Rascunho'
          WHEN PublicadoEm IS NOT NULL AND Ativo = 1 THEN 'Publicado'
          ELSE 'Arquivado'
        END AS Status
      FROM dbo.DocumentosLegais
      WHERE (@Tipo IS NULL OR Tipo = @Tipo)
      ORDER BY
        Tipo,
        CASE
          WHEN Ativo = 1 THEN 0
          WHEN PublicadoEm IS NULL THEN 1
          ELSE 2
        END,
        PublicadoEm DESC,
        AtualizadoEm DESC,
        Id DESC;
    `);

    return result.recordset || [];
  },

  async listarAtivos(usuario) {
    requireAdmin(usuario);

    const result = await queryWithContext(usuario, null, `
      IF OBJECT_ID('dbo.DocumentosLegais', 'U') IS NULL
        THROW 50000, 'Infraestrutura de documentos legais indisponível.', 1;

      SELECT
        Id,
        Tipo,
        Versao,
        Titulo,
        Ativo,
        PublicadoEm,
        CriadoEm,
        AtualizadoEm
      FROM dbo.DocumentosLegais
      WHERE Ativo = 1
      ORDER BY Tipo, AtualizadoEm DESC;
    `);

    return result.recordset || [];
  },

  async obterPorId(usuario, { id }) {
    requireAdmin(usuario);

    const docId = Number(id);
    if (!Number.isFinite(docId) || docId <= 0) {
      throw new HttpError(400, 'id inválido.');
    }

    const result = await queryWithContext(usuario, (req) => {
      req.input('DocumentoLegalId', sql.Int, docId);
    }, `
      IF OBJECT_ID('dbo.DocumentosLegais', 'U') IS NULL
        THROW 50000, 'Infraestrutura de documentos legais indisponível.', 1;

      SELECT TOP 1
        Id,
        Tipo,
        Versao,
        Titulo,
        Conteudo,
        Ativo,
        PublicadoEm,
        CriadoPorAdminId,
        CriadoEm,
        AtualizadoEm
      FROM dbo.DocumentosLegais
      WHERE Id = @DocumentoLegalId;
    `);

    const item = result.recordset?.[0] || null;
    if (!item) throw new HttpError(404, 'Documento legal não encontrado.');
    return item;
  },

  async criarRascunho(usuario, { tipo, versao, titulo, conteudo }) {
    requireAdmin(usuario);

    if (!tipo || !versao || !conteudo) {
      throw new HttpError(400, 'tipo, versao e conteudo são obrigatórios.');
    }

    const tipoNorm = normalizarTipo(tipo);
    const versaoNorm = String(versao).trim();
    if (!versaoNorm) throw new HttpError(400, 'versao é obrigatória.');
    if (versaoNorm.length > 80) throw new HttpError(400, 'versao deve ter no máximo 80 caracteres.');

    const tituloNorm = titulo === undefined || titulo === null ? null : String(titulo).trim();
    if (tituloNorm && tituloNorm.length > 400) {
      throw new HttpError(400, 'titulo deve ter no máximo 400 caracteres.');
    }

    const conteudoNorm = String(conteudo);

    let result;
    try {
      result = await queryWithContext(usuario, (req) => {
        req.input('Tipo', sql.NVarChar(80), tipoNorm);
        req.input('Versao', sql.NVarChar(80), versaoNorm);
        req.input('Titulo', sql.NVarChar(400), tituloNorm);
        req.input('Conteudo', sql.NVarChar(sql.MAX), conteudoNorm);
        req.input('Ativar', sql.Bit, 0); // rascunho
      }, `
        IF OBJECT_ID('dbo.sp_CriarDocumentoLegal', 'P') IS NULL
          THROW 50010, 'Infraestrutura de documentos legais indisponível.', 1;

        EXEC dbo.sp_CriarDocumentoLegal
          @Tipo = @Tipo,
          @Versao = @Versao,
          @Titulo = @Titulo,
          @Conteudo = @Conteudo,
          @Ativar = @Ativar;
      `);
    } catch (err) {
      const mapped = mapLegaisDbError(err);
      if (mapped) throw mapped;
      throw err;
    }

    return result.recordset?.[0] ?? { ok: true };
  },

  /**
   * Edita rascunho: usa somente @DocumentoLegalId, @Titulo, @Conteudo,
   * respeitando a assinatura real da dbo.sp_AtualizarDocumentoLegalRascunho.
   */
  async editarRascunho(usuario, { id, titulo, conteudo }) {
    requireAdmin(usuario);

    const docId = Number(id);
    if (!Number.isFinite(docId) || docId <= 0) {
      throw new HttpError(400, 'id inválido.');
    }

    if (!conteudo || !String(conteudo).trim()) {
      throw new HttpError(400, 'conteudo é obrigatório.');
    }

    const tituloNorm = titulo === undefined || titulo === null ? null : String(titulo).trim();
    if (tituloNorm && tituloNorm.length > 200) {
      throw new HttpError(400, 'titulo deve ter no máximo 200 caracteres.');
    }

    // Chama a SP exatamente com os 3 parâmetros:
    // @DocumentoLegalId INT (obrigatório)
    // @Titulo NVARCHAR(200) = NULL (opcional)
    // @Conteudo NVARCHAR(MAX) (obrigatório)
    let result;
    try {
      result = await queryWithContext(usuario, (req) => {
        req.input('DocumentoLegalId', sql.Int, docId);
        req.input('Titulo', sql.NVarChar(200), tituloNorm);
        req.input('Conteudo', sql.NVarChar(sql.MAX), String(conteudo));
      }, `
        BEGIN TRY
          BEGIN TRAN;

          IF NOT EXISTS (
            SELECT 1
            FROM dbo.DocumentosLegais WITH (UPDLOCK, HOLDLOCK)
            WHERE Id = @DocumentoLegalId
          )
            THROW 50002, 'Documento legal não encontrado.', 1;

          IF EXISTS (
            SELECT 1
            FROM dbo.DocumentosLegais WITH (UPDLOCK, HOLDLOCK)
            WHERE Id = @DocumentoLegalId
              AND (Ativo = 1 OR PublicadoEm IS NOT NULL)
          )
            THROW 50003, 'Este documento já foi publicado/ativado. Só é permitido editar rascunhos.', 1;

          IF OBJECT_ID('dbo.sp_AtualizarDocumentoLegalRascunho', 'P') IS NULL
            THROW 50011, 'Infraestrutura de documentos legais indisponível.', 1;

          EXEC dbo.sp_AtualizarDocumentoLegalRascunho
            @DocumentoLegalId = @DocumentoLegalId,
            @Titulo = @Titulo,
            @Conteudo = @Conteudo;

          COMMIT;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          THROW;
        END CATCH
      `);
    } catch (err) {
      const mapped = mapLegaisDbError(err);
      if (mapped) throw mapped;
      throw err;
    }

    return result.recordset?.[0] ?? { ok: true };
  },

  async publicar(usuario, { id }) {
    requireAdmin(usuario);

    const docId = Number(id);
    if (!Number.isFinite(docId) || docId <= 0) {
      throw new HttpError(400, 'id inválido.');
    }

    let result;
    try {
      result = await queryWithContext(usuario, (req) => {
        req.input('DocumentoLegalId', sql.Int, docId);
      }, `
        IF OBJECT_ID('dbo.sp_PublicarDocumentoLegal', 'P') IS NULL
          THROW 50012, 'Infraestrutura de documentos legais indisponível.', 1;

        EXEC dbo.sp_PublicarDocumentoLegal
          @DocumentoLegalId = @DocumentoLegalId;
      `);
    } catch (err) {
      const mapped = mapLegaisDbError(err);
      if (mapped) throw mapped;
      throw err;
    }

    return result.recordset?.[0] ?? { ok: true };
  },

  async desativar(usuario, { id }) {
    requireAdmin(usuario);

    const docId = Number(id);
    if (!Number.isFinite(docId) || docId <= 0) {
      throw new HttpError(400, 'id inválido.');
    }

    let result;
    try {
      result = await queryWithContext(usuario, (req) => {
        req.input('DocumentoLegalId', sql.Int, docId);
      }, `
        BEGIN TRY
          BEGIN TRAN;

          IF NOT EXISTS (
            SELECT 1
            FROM dbo.DocumentosLegais WITH (UPDLOCK, HOLDLOCK)
            WHERE Id = @DocumentoLegalId
          )
            THROW 50002, 'Documento legal não encontrado.', 1;

          UPDATE dbo.DocumentosLegais
          SET Ativo = 0,
              AtualizadoEm = SYSDATETIME()
          WHERE Id = @DocumentoLegalId;

          SELECT TOP 1
            Id, Tipo, Versao, Titulo, Ativo, PublicadoEm, CriadoEm, AtualizadoEm
          FROM dbo.DocumentosLegais
          WHERE Id = @DocumentoLegalId;

          COMMIT;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          THROW;
        END CATCH
      `);
    } catch (err) {
      const mapped = mapLegaisDbError(err);
      if (mapped) throw mapped;
      throw err;
    }

    return result.recordset?.[0] ?? { ok: true };
  },

  async ativar(usuario, { id }) {
    requireAdmin(usuario);

    const docId = Number(id);
    if (!Number.isFinite(docId) || docId <= 0) {
      throw new HttpError(400, 'id inválido.');
    }

    let result;
    try {
      result = await queryWithContext(usuario, (req) => {
        req.input('DocumentoLegalId', sql.Int, docId);
      }, `
        BEGIN TRY
          BEGIN TRAN;

          DECLARE @Tipo NVARCHAR(80) = NULL;

          SELECT TOP 1
            @Tipo = Tipo
          FROM dbo.DocumentosLegais WITH (UPDLOCK, HOLDLOCK)
          WHERE Id = @DocumentoLegalId;

          IF @Tipo IS NULL
            THROW 50002, 'Documento legal não encontrado.', 1;

          IF NOT EXISTS (
            SELECT 1
            FROM dbo.DocumentosLegais
            WHERE Id = @DocumentoLegalId
              AND PublicadoEm IS NOT NULL
          )
            THROW 50004, 'Documento não pode ser ativado: nunca foi publicado. Use o endpoint publicar primeiro.', 1;

          -- Garante unicidade por Tipo para Ativo = 1 (UX_DocumentosLegais_Tipo_Ativo)
          UPDATE dbo.DocumentosLegais
          SET Ativo = 0,
              AtualizadoEm = SYSDATETIME()
          WHERE Tipo = @Tipo
            AND Id <> @DocumentoLegalId
            AND Ativo = 1;

          UPDATE dbo.DocumentosLegais
          SET Ativo = 1,
              PublicadoEm = ISNULL(PublicadoEm, SYSDATETIME()),
              AtualizadoEm = SYSDATETIME()
          WHERE Id = @DocumentoLegalId;

          SELECT TOP 1
            Id, Tipo, Versao, Titulo, Ativo, PublicadoEm, CriadoEm, AtualizadoEm
          FROM dbo.DocumentosLegais
          WHERE Id = @DocumentoLegalId;

          COMMIT;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          THROW;
        END CATCH
      `);
    } catch (err) {
      const mapped = mapLegaisDbError(err);
      if (mapped) throw mapped;
      throw err;
    }

    return result.recordset?.[0] ?? { ok: true };
  },

  async excluir(usuario, { id }) {
    requireAdmin(usuario);

    const docId = Number(id);
    if (!Number.isFinite(docId) || docId <= 0) {
      throw new HttpError(400, 'id inválido.');
    }

    try {
      const result = await queryWithContext(usuario, (req) => {
        req.input('DocumentoLegalId', sql.Int, docId);
      }, `
        BEGIN TRY
          BEGIN TRAN;

          IF NOT EXISTS (
            SELECT 1
            FROM dbo.DocumentosLegais WITH (UPDLOCK, HOLDLOCK)
            WHERE Id = @DocumentoLegalId
          )
            THROW 50002, 'Documento legal não encontrado.', 1;

          IF EXISTS (
            SELECT 1
            FROM dbo.AceitesDocumentosLegais WITH (UPDLOCK, HOLDLOCK)
            WHERE DocumentoLegalId = @DocumentoLegalId
          )
            THROW 50021, 'Documento legal possui aceites vinculados e não pode ser excluído.', 1;

          DELETE FROM dbo.DocumentosLegais
          WHERE Id = @DocumentoLegalId;

          SELECT @@ROWCOUNT AS LinhasAfetadas;

          COMMIT;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          THROW;
        END CATCH
      `);

      return { ok: true, excluido: (result.recordset?.[0]?.LinhasAfetadas || 0) > 0 };
    } catch (err) {
      const mapped = mapLegaisDbError(err);
      if (mapped) throw mapped;
      throw err;
    }
  }
};

export default adminLegaisService;
