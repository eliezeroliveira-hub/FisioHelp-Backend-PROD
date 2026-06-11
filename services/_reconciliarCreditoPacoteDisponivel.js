import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';

export async function reconciliarCreditoPacoteDisponivelPorConsulta(consultaId, usuario) {
  const id = Number(consultaId);
  if (!Number.isInteger(id) || id <= 0) {
    return { CreditosReconciliados: 0, PacotesAjustados: 0 };
  }

  const result = await queryWithContext(
    usuario,
    (req) => {
      req.input('ConsultaId', sql.Int, id);
    },
    `
      SET NOCOUNT ON;
      SET XACT_ABORT ON;

      BEGIN TRY
        BEGIN TRAN;

        DECLARE @CreditosAjustados TABLE (PacoteId INT NOT NULL);

        -- Quando um estorno de pacote devolve o crédito, ele precisa
        -- voltar a ficar reutilizável no pacote: sem ConsultaId e com
        -- a contagem de consultas utilizadas ajustada.
        UPDATE cp
          SET Status = N'Disponivel',
              UsadoEm = NULL,
              ConsultaId = NULL
          OUTPUT inserted.PacoteId INTO @CreditosAjustados (PacoteId)
        FROM dbo.CreditosPacientes cp WITH (UPDLOCK, HOLDLOCK)
        WHERE cp.ConsultaId = @ConsultaId
          AND cp.PacoteId IS NOT NULL
          AND LTRIM(RTRIM(ISNULL(cp.Status, N''))) = N'Disponivel';

        ;WITH PacotesImpactados AS (
          SELECT PacoteId, COUNT(1) AS Quantidade
          FROM @CreditosAjustados
          GROUP BY PacoteId
        )
        UPDATE p
          SET ConsultasUtilizadas =
            CASE
              WHEN ISNULL(p.ConsultasUtilizadas, 0) > pi.Quantidade
                THEN ISNULL(p.ConsultasUtilizadas, 0) - pi.Quantidade
              ELSE 0
            END
        FROM dbo.Pacotes p
        INNER JOIN PacotesImpactados pi
          ON pi.PacoteId = p.Id;

        SELECT
          (SELECT COUNT(1) FROM @CreditosAjustados) AS CreditosReconciliados,
          (
            SELECT COUNT(1)
            FROM (SELECT DISTINCT PacoteId FROM @CreditosAjustados) p
          ) AS PacotesAjustados;

        COMMIT;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH
    `
  );

  return result?.recordset?.[0] ?? { CreditosReconciliados: 0, PacotesAjustados: 0 };
}
