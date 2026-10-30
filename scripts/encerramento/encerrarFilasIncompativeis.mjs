import 'dotenv/config';

import getPool, { sql } from '../../config/dbConfig.js';
import { queryWithContext } from '../../services/_queryWithContext.js';

const TIPOS_PROMOCIONAIS_ENCERRADOS = [
  'campanha_ativacao_primeira_consulta_paciente',
  'campanha_indicacao_fisioterapeuta',
  'lembrete_perfil_fisioterapeuta',
];
const CONFIRMACAO = 'ENCERRAMENTO-2026-11-30';

function readArgument(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function requiredArgument(name) {
  const value = String(readArgument(name) || '').trim();
  if (!value) throw new Error(`Informe --${name}.`);
  return value;
}

const execute = process.argv.includes('--execute');
const expectedDatabase = requiredArgument('expected-database');
const actualDatabase = String(process.env.DB_NAME || '').trim();
if (!actualDatabase || actualDatabase.toLowerCase() !== expectedDatabase.toLowerCase()) {
  throw new Error(`Banco recusado: DB_NAME não corresponde a --expected-database (${expectedDatabase}).`);
}
if (execute && readArgument('confirm') !== CONFIRMACAO) {
  throw new Error(`Para executar, informe --confirm=${CONFIRMACAO}.`);
}

const usuario = { tipo: 'Admin', id: Number(process.env.SYSTEM_ADMIN_ID || 1) };
const tiposJson = JSON.stringify(TIPOS_PROMOCIONAIS_ENCERRADOS);

async function inventariar() {
  return queryWithContext(usuario, (req) => {
    req.input('TiposJson', sql.NVarChar(sql.MAX), tiposJson);
  }, `
    SET NOCOUNT ON;

    SELECT
      N'FilaNotificacoes' AS Fila,
      CASE WHEN ISJSON(fn.DadosJson) = 1 THEN JSON_VALUE(fn.DadosJson, '$.tipo') END AS Tipo,
      fn.Status,
      COUNT_BIG(1) AS Total
    FROM dbo.FilaNotificacoes fn
    INNER JOIN OPENJSON(@TiposJson) tipos
      ON tipos.[value] = CASE WHEN ISJSON(fn.DadosJson) = 1 THEN JSON_VALUE(fn.DadosJson, '$.tipo') END
    WHERE fn.Status IN (N'Pendente', N'FalhaTemporaria', N'Processando')
    GROUP BY CASE WHEN ISJSON(fn.DadosJson) = 1 THEN JSON_VALUE(fn.DadosJson, '$.tipo') END, fn.Status

    UNION ALL

    SELECT
      N'FilaContatoTransacional' AS Fila,
      fct.Tipo,
      fct.Status,
      COUNT_BIG(1) AS Total
    FROM dbo.FilaContatoTransacional fct
    WHERE fct.Status IN (N'Pendente', N'FalhaTemporaria', N'Processando')
      AND (
        LOWER(fct.Tipo) LIKE N'%pre%cadastro%'
        OR LOWER(COALESCE(fct.Html, N'')) LIKE N'%ativar-pre-cadastro%'
        OR LOWER(COALESCE(fct.Texto, N'')) LIKE N'%ativar-pre-cadastro%'
        OR LOWER(COALESCE(fct.PayloadJson, N'')) LIKE N'%ativar-pre-cadastro%'
      )
    GROUP BY fct.Tipo, fct.Status
    ORDER BY Fila, Tipo, Status;
  `, { requireContext: true });
}

async function encerrar() {
  return queryWithContext(usuario, (req) => {
    req.input('TiposJson', sql.NVarChar(sql.MAX), tiposJson);
  }, `
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;

    IF EXISTS (
      SELECT 1
      FROM dbo.FilaNotificacoes fn
      INNER JOIN OPENJSON(@TiposJson) tipos
        ON tipos.[value] = CASE WHEN ISJSON(fn.DadosJson) = 1 THEN JSON_VALUE(fn.DadosJson, '$.tipo') END
      WHERE fn.Status = N'Processando'
    )
      THROW 51000, 'Há notificações incompatíveis em Processando. Aguarde o término e repita.', 1;

    IF EXISTS (
      SELECT 1
      FROM dbo.FilaContatoTransacional fct
      WHERE fct.Status = N'Processando'
        AND (
          LOWER(fct.Tipo) LIKE N'%pre%cadastro%'
          OR LOWER(COALESCE(fct.Html, N'')) LIKE N'%ativar-pre-cadastro%'
          OR LOWER(COALESCE(fct.Texto, N'')) LIKE N'%ativar-pre-cadastro%'
          OR LOWER(COALESCE(fct.PayloadJson, N'')) LIKE N'%ativar-pre-cadastro%'
        )
    )
      THROW 51001, 'Há convites de pré-cadastro em Processando. Aguarde o término e repita.', 1;

    UPDATE fn
    SET
      fn.Status = N'FalhaDefinitiva',
      fn.UltimoErro = N'Item encerrado administrativamente antes do encerramento da operação.',
      fn.ProcessandoEm = NULL,
      fn.ProximaTentativaEm = NULL,
      fn.AtualizadoEm = SYSDATETIME()
    FROM dbo.FilaNotificacoes fn
    INNER JOIN OPENJSON(@TiposJson) tipos
      ON tipos.[value] = CASE WHEN ISJSON(fn.DadosJson) = 1 THEN JSON_VALUE(fn.DadosJson, '$.tipo') END
    WHERE fn.Status IN (N'Pendente', N'FalhaTemporaria');
    DECLARE @NotificacoesEncerradas bigint = @@ROWCOUNT;

    UPDATE fct
    SET
      fct.Status = N'FalhaPermanente',
      fct.ErroMensagem = N'Convite de pré-cadastro encerrado administrativamente.',
      fct.ProcessandoEm = NULL,
      fct.ProximaTentativaEm = NULL,
      fct.AtualizadoEm = SYSDATETIME()
    FROM dbo.FilaContatoTransacional fct
    WHERE fct.Status IN (N'Pendente', N'FalhaTemporaria')
      AND (
        LOWER(fct.Tipo) LIKE N'%pre%cadastro%'
        OR LOWER(COALESCE(fct.Html, N'')) LIKE N'%ativar-pre-cadastro%'
        OR LOWER(COALESCE(fct.Texto, N'')) LIKE N'%ativar-pre-cadastro%'
        OR LOWER(COALESCE(fct.PayloadJson, N'')) LIKE N'%ativar-pre-cadastro%'
      );
    DECLARE @ConvitesEncerrados bigint = @@ROWCOUNT;

    COMMIT;
    SELECT @NotificacoesEncerradas AS NotificacoesEncerradas, @ConvitesEncerrados AS ConvitesEncerrados;
  `, { requireContext: true });
}

let pool;
try {
  pool = await getPool();
  const preview = await inventariar();
  console.table(preview.recordset || []);
  console.log('BCMED e Jalecos Conforto não fazem parte dos tipos deste script.');
  if (!execute) {
    console.log('Dry-run concluído. Nenhuma linha foi alterada.');
  } else {
    const result = await encerrar();
    console.table(result.recordset || []);
  }
} finally {
  await pool?.close();
}
