import { sql } from '../config/dbConfig.js';
import { queryWithContext } from '../services/_queryWithContext.js';

export const COMUNICADO_ENCERRAMENTO_DADOS_TIPO =
  'comunicado_encerramento_operacao_2026';
export const COMUNICADO_ENCERRAMENTO_EMAIL_MODELO =
  'comunicado_encerramento_operacao';
export const COMUNICADO_ENCERRAMENTO_CAMPANHA_ID =
  'encerramento-operacao-2026-11-30';
export const COMUNICADO_ENCERRAMENTO_CONFIRMACAO =
  'ENCERRAMENTO-COMUNICADO-2026-11-30';

const TITULO_EMAIL = 'Comunicado importante: encerramento das operações da FisioHelp';
const MENSAGEM_EMAIL =
  'Informações sobre o encerramento da FisioHelp, acesso aos dados e canais de suporte.';

function usuarioSistema() {
  return { tipo: 'Admin', id: Number(process.env.SYSTEM_ADMIN_ID ?? 1) };
}

function flagAtiva(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function erroOperacional(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function bindComunicado(req) {
  req.input('DadosTipo', sql.NVarChar(100), COMUNICADO_ENCERRAMENTO_DADOS_TIPO);
  req.input('EmailModelo', sql.NVarChar(100), COMUNICADO_ENCERRAMENTO_EMAIL_MODELO);
  req.input('CampanhaId', sql.NVarChar(100), COMUNICADO_ENCERRAMENTO_CAMPANHA_ID);
}

const FONTES_SQL = `
  SELECT
    N'Fisioterapeuta' AS UsuarioTipo,
    f.Id AS UsuarioId,
    NULLIF(LTRIM(RTRIM(f.Nome)), N'') AS NomeDestinatario,
    LOWER(LTRIM(RTRIM(f.Email))) AS EmailNormalizado,
    1 AS Prioridade
  FROM dbo.Fisioterapeutas f
  WHERE ISNULL(f.Ativo, 0) = 1
    AND ISNULL(f.EmailVerificado, 0) = 1
    AND NULLIF(LTRIM(RTRIM(ISNULL(f.Email, N''))), N'') IS NOT NULL

  UNION ALL

  SELECT
    N'Paciente' AS UsuarioTipo,
    p.Id AS UsuarioId,
    NULLIF(LTRIM(RTRIM(p.Nome)), N'') AS NomeDestinatario,
    LOWER(LTRIM(RTRIM(p.Email))) AS EmailNormalizado,
    2 AS Prioridade
  FROM dbo.Pacientes p
  WHERE ISNULL(p.Ativo, 0) = 1
    AND ISNULL(p.EmailVerificado, 0) = 1
    AND NULLIF(LTRIM(RTRIM(ISNULL(p.Email, N''))), N'') IS NOT NULL
`;

async function inventariar() {
  const result = await queryWithContext(
    usuarioSistema(),
    bindComunicado,
    `
      ;WITH fontes AS (
        ${FONTES_SQL}
      ), rankeados AS (
        SELECT
          f.*,
          ROW_NUMBER() OVER (
            PARTITION BY f.EmailNormalizado
            ORDER BY f.Prioridade ASC, f.UsuarioId ASC
          ) AS Ordem,
          LOWER(CONVERT(varchar(64), HASHBYTES(
            'SHA2_256', CONVERT(varbinary(max), f.EmailNormalizado)
          ), 2)) AS DestinatarioHash
        FROM fontes f
      ), unicos AS (
        SELECT * FROM rankeados WHERE Ordem = 1
      )
      SELECT
        CONVERT(bigint, (SELECT COUNT_BIG(1) FROM fontes)) AS CadastrosComEmailVerificado,
        CONVERT(bigint, (SELECT COUNT_BIG(1) FROM unicos)) AS EmailsUnicos,
        CONVERT(bigint, (
          SELECT COUNT_BIG(1) FROM unicos u
          WHERE EXISTS (
            SELECT 1 FROM dbo.EmailSupressao es
            WHERE LOWER(LTRIM(RTRIM(es.Email))) = u.EmailNormalizado
          )
        )) AS EmailsSuprimidos,
        CONVERT(bigint, (
          SELECT COUNT_BIG(1) FROM unicos u
          WHERE NOT EXISTS (
            SELECT 1 FROM dbo.EmailSupressao es
            WHERE LOWER(LTRIM(RTRIM(es.Email))) = u.EmailNormalizado
          )
        )) AS DestinatariosElegiveis,
        CONVERT(bigint, (
          SELECT COUNT_BIG(1) FROM unicos u
          WHERE NOT EXISTS (
            SELECT 1 FROM dbo.EmailSupressao es
            WHERE LOWER(LTRIM(RTRIM(es.Email))) = u.EmailNormalizado
          )
          AND EXISTS (
            SELECT 1 FROM dbo.FilaNotificacoes fn
            WHERE fn.Canal = N'email'
              AND CASE WHEN ISJSON(fn.DadosJson) = 1
                THEN JSON_VALUE(fn.DadosJson, '$.tipo') END = @DadosTipo
              AND CASE WHEN ISJSON(fn.DadosJson) = 1
                THEN JSON_VALUE(fn.DadosJson, '$.campanhaId') END = @CampanhaId
              AND CASE WHEN ISJSON(fn.DadosJson) = 1
                THEN JSON_VALUE(fn.DadosJson, '$.destinatarioHash') END = u.DestinatarioHash
          )
        )) AS JaEnfileirados;

      SELECT fn.Status, COUNT_BIG(1) AS Total
      FROM dbo.FilaNotificacoes fn
      WHERE fn.Canal = N'email'
        AND CASE WHEN ISJSON(fn.DadosJson) = 1
          THEN JSON_VALUE(fn.DadosJson, '$.tipo') END = @DadosTipo
        AND CASE WHEN ISJSON(fn.DadosJson) = 1
          THEN JSON_VALUE(fn.DadosJson, '$.campanhaId') END = @CampanhaId
      GROUP BY fn.Status
      ORDER BY fn.Status;
    `,
    { requireContext: true }
  );

  const summary = result.recordsets?.[0]?.[0] ?? {};
  const statuses = result.recordsets?.[1] ?? [];
  const destinatariosElegiveis = Number(summary.DestinatariosElegiveis ?? 0);
  const jaEnfileirados = Number(summary.JaEnfileirados ?? 0);

  return {
    campanhaId: COMUNICADO_ENCERRAMENTO_CAMPANHA_ID,
    cadastrosComEmailVerificado: Number(summary.CadastrosComEmailVerificado ?? 0),
    emailsUnicos: Number(summary.EmailsUnicos ?? 0),
    emailsSuprimidos: Number(summary.EmailsSuprimidos ?? 0),
    destinatariosElegiveis,
    jaEnfileirados,
    aindaNaoEnfileirados: Math.max(0, destinatariosElegiveis - jaEnfileirados),
    fila: Object.fromEntries(
      statuses.map((row) => [String(row.Status), Number(row.Total ?? 0)])
    ),
  };
}

async function enfileirar() {
  const result = await queryWithContext(
    usuarioSistema(),
    (req) => {
      bindComunicado(req);
      req.input('Titulo', sql.NVarChar(120), TITULO_EMAIL);
      req.input('Mensagem', sql.NVarChar(500), MENSAGEM_EMAIL);
      req.input(
        'UsuarioRegistro',
        sql.NVarChar(200),
        'Sistema:ComunicadoEncerramentoOperacao'
      );
    },
    `
      SET XACT_ABORT ON;

      BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @LockResult int;
        EXEC @LockResult = sys.sp_getapplock
          @Resource = N'comunicado-encerramento-operacao-2026-11-30',
          @LockMode = N'Exclusive',
          @LockOwner = N'Transaction',
          @LockTimeout = 10000;

        IF @LockResult < 0
          THROW 51000, 'Não foi possível obter o lock do comunicado de encerramento.', 1;

        ;WITH fontes AS (
          ${FONTES_SQL}
        ), rankeados AS (
          SELECT
            f.*,
            ROW_NUMBER() OVER (
              PARTITION BY f.EmailNormalizado
              ORDER BY f.Prioridade ASC, f.UsuarioId ASC
            ) AS Ordem,
            LOWER(CONVERT(varchar(64), HASHBYTES(
              'SHA2_256', CONVERT(varbinary(max), f.EmailNormalizado)
            ), 2)) AS DestinatarioHash
          FROM fontes f
        ), candidatos AS (
          SELECT r.*
          FROM rankeados r
          WHERE r.Ordem = 1
            AND NOT EXISTS (
              SELECT 1 FROM dbo.EmailSupressao es
              WHERE LOWER(LTRIM(RTRIM(es.Email))) = r.EmailNormalizado
            )
        )
        INSERT INTO dbo.FilaNotificacoes
          (UsuarioTipo, UsuarioId, Canal, Tipo, Titulo, Mensagem, DadosJson,
           ReferenciaId, UsuarioRegistro)
        SELECT
          c.UsuarioTipo,
          c.UsuarioId,
          N'email',
          N'Promocao',
          @Titulo,
          @Mensagem,
          dados.DadosJson,
          c.UsuarioId,
          @UsuarioRegistro
        FROM candidatos c
        CROSS APPLY (
          SELECT
            @DadosTipo AS tipo,
            @EmailModelo AS emailModelo,
            @CampanhaId AS campanhaId,
            N'email' AS canal,
            c.NomeDestinatario AS nomeDestinatario,
            c.DestinatarioHash AS destinatarioHash,
            N'comunicadoEncerramentoOperacaoWorker' AS origem
          FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
        ) dados(DadosJson)
        WHERE NOT EXISTS (
          SELECT 1
          FROM dbo.FilaNotificacoes fn WITH (UPDLOCK, HOLDLOCK)
          WHERE fn.Canal = N'email'
            AND CASE WHEN ISJSON(fn.DadosJson) = 1
              THEN JSON_VALUE(fn.DadosJson, '$.tipo') END = @DadosTipo
            AND CASE WHEN ISJSON(fn.DadosJson) = 1
              THEN JSON_VALUE(fn.DadosJson, '$.campanhaId') END = @CampanhaId
            AND CASE WHEN ISJSON(fn.DadosJson) = 1
              THEN JSON_VALUE(fn.DadosJson, '$.destinatarioHash') END = c.DestinatarioHash
        );

        DECLARE @Inseridos int = @@ROWCOUNT;
        COMMIT TRANSACTION;
        SELECT @Inseridos AS Inseridos;
      END TRY
      BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH;
    `,
    { requireContext: true }
  );

  return Number(result.recordset?.[0]?.Inseridos ?? 0);
}

export async function executarComunicadoEncerramentoOperacao({
  acao = 'inventariar',
  confirmacao = '',
} = {}) {
  const action = String(acao ?? '').trim().toLowerCase();

  if (action === 'inventariar' || action === 'acompanhar') {
    return { acao: action, ...(await inventariar()) };
  }

  if (action !== 'enfileirar') {
    throw erroOperacional('Ação inválida. Use inventariar, acompanhar ou enfileirar.');
  }

  if (!flagAtiva(process.env.ENCERRAMENTO_COMUNICADO_ENABLED)) {
    throw erroOperacional('Disparo do comunicado desativado.', 403);
  }

  if (String(confirmacao ?? '').trim() !== COMUNICADO_ENCERRAMENTO_CONFIRMACAO) {
    throw erroOperacional('Confirmação operacional inválida.', 403);
  }

  const inseridos = await enfileirar();
  return {
    acao: action,
    inseridos,
    ...(await inventariar()),
  };
}

export default { executarComunicadoEncerramentoOperacao };
