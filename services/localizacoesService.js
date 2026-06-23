// 📁 services/localizacoesService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';
import { agoraBrasilDate } from '../utils/appDateTime.js';

function asFiniteNumber(v, label) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${label} inválido.`);
  return n;
}

function assertLatLon(latitude, longitude) {
  const lat = asFiniteNumber(latitude, 'latitude');
  const lon = asFiniteNumber(longitude, 'longitude');
  if (lat < -90 || lat > 90) throw new HttpError(400, 'latitude inválida (de -90 a 90).');
  if (lon < -180 || lon > 180) throw new HttpError(400, 'longitude inválida (de -180 a 180).');
  return { lat, lon };
}

function assertRaioKm(v, label) {
  const raio = asFiniteNumber(v, label);
  if (raio <= 0 || raio > 500) throw new HttpError(400, `${label} inválido (deve ser > 0 e <= 500).`);
  return raio;
}

function normalizePaginacao(limit, offset) {
  const limRaw = Number.parseInt(limit, 10);
  const offRaw = Number.parseInt(offset, 10);
  const lim = Number.isFinite(limRaw) ? limRaw : 50;
  const off = Number.isFinite(offRaw) ? offRaw : 0;
  return {
    limit: Math.min(Math.max(lim, 1), 200),
    offset: Math.max(off, 0)
  };
}

const localizacoesService = {
  async upsertMinhaLocalizacao({ usuarioTipo, usuarioId }, payload) {
    const { latitude, longitude, raioAtendimentoKm, cidade, estado, cep, logradouro, numero } = payload;
    let lat = null;
    let lon = null;

    if (latitude != null || longitude != null) {
      const coords = assertLatLon(latitude, longitude);
      lat = coords.lat;
      lon = coords.lon;
    }

    const raio = assertRaioKm(raioAtendimentoKm, 'raioAtendimentoKm');
    const contexto = { id: usuarioId, tipo: usuarioTipo };

    const sqlText = `
      SET XACT_ABORT ON;

      BEGIN TRY
        BEGIN TRAN;

        UPDATE dbo.Localizacoes WITH (UPDLOCK, HOLDLOCK)
          SET
            RaioAtendimentoKm = @Raio,
            Cidade = @Cidade,
            Estado = @Estado,
            CEP = @Cep,
            Logradouro = @Logradouro,
            Numero = @Numero,
            Latitude = CASE WHEN @Lat IS NOT NULL THEN @Lat ELSE Latitude END,
            Longitude = CASE WHEN @Lon IS NOT NULL THEN @Lon ELSE Longitude END,
            GeoLocalizacao = CASE
              WHEN @Lat IS NOT NULL AND @Lon IS NOT NULL THEN geography::Point(@Lat, @Lon, 4326)
              ELSE GeoLocalizacao
            END,
            AtualizadoEm = @AgoraBrasil
        WHERE FisioterapeutaId = @FisioterapeutaId;

        IF @@ROWCOUNT = 0
        BEGIN
          INSERT INTO dbo.Localizacoes (FisioterapeutaId, Latitude, Longitude, RaioAtendimentoKm, Cidade, Estado, CEP, Logradouro, Numero, GeoLocalizacao, AtualizadoEm)
          VALUES (
            @FisioterapeutaId,
            @Lat,
            @Lon,
            @Raio,
            @Cidade,
            @Estado,
            @Cep,
            @Logradouro,
            @Numero,
            CASE
              WHEN @Lat IS NOT NULL AND @Lon IS NOT NULL THEN geography::Point(@Lat, @Lon, 4326)
              ELSE NULL
            END,
            @AgoraBrasil
          );
        END;

        SELECT TOP 1
          FisioterapeutaId,
          Latitude,
          Longitude,
          RaioAtendimentoKm,
          Cidade,
          Estado,
          CEP,
          Logradouro,
          Numero,
          AtualizadoEm
        FROM dbo.Localizacoes
        WHERE FisioterapeutaId = @FisioterapeutaId;

        COMMIT;
      END TRY
      BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;
        ;THROW;
      END CATCH;
    `;

    const result = await queryWithContext(
      contexto,
      (req) => {
        req.input('FisioterapeutaId', sql.Int, usuarioId);
        req.input('Lat', sql.Decimal(9, 6), lat);
        req.input('Lon', sql.Decimal(9, 6), lon);
        req.input('Raio', sql.Decimal(5, 2), raio);
        req.input('Cidade', sql.NVarChar(200), cidade ?? null);
        req.input('Estado', sql.NVarChar(200), estado ?? null);
        req.input('Cep', sql.NVarChar(9), cep ?? null);
        req.input('Logradouro', sql.NVarChar(400), logradouro ?? null);
        req.input('Numero', sql.NVarChar(20), numero ?? null);
        req.input('AgoraBrasil', sql.DateTime2(7), agoraBrasilDate());
      },
      sqlText,
      { requireContext: true }
    );

    return result?.recordset?.[0] ?? null;
  },

  async obterMinhaLocalizacao({ usuarioTipo, usuarioId }) {
    const contexto = { id: usuarioId, tipo: usuarioTipo };
    const sqlText = `
      SELECT TOP 1
        FisioterapeutaId,
        Latitude,
        Longitude,
        RaioAtendimentoKm,
        Cidade,
        Estado,
        CEP,
        Logradouro,
        Numero,
        AtualizadoEm
      FROM dbo.Localizacoes
      WHERE FisioterapeutaId = @FisioterapeutaId;
    `;

    const result = await queryWithContext(
      contexto,
      (req) => {
        req.input('FisioterapeutaId', sql.Int, usuarioId);
      },
      sqlText,
      { requireContext: true }
    );

    return result?.recordset?.[0] ?? null;
  },

  // ⚠️ Só vai funcionar para Paciente se sua RLS permitir leitura.
  async buscarFisioterapeutasProximos({ usuarioTipo, usuarioId }, { lat, lon, raioBuscaKm, limit = 50, offset = 0 }) {
    const { lat: latNum, lon: lonNum } = assertLatLon(lat, lon);
    const raio = assertRaioKm(raioBuscaKm, 'raioBuscaKm');
    const paginacao = normalizePaginacao(limit, offset);
    const contexto = { id: usuarioId, tipo: usuarioTipo };

    const sqlText = `
      DECLARE @Ponto geography = geography::Point(@LatPaciente, @LonPaciente, 4326);

      ;WITH Base AS (
        SELECT
          f.Id AS FisioterapeutaId,
          f.Nome,
          l.Cidade,
          l.Estado,
          l.RaioAtendimentoKm,
          CAST(d.DistM / 1000.0 AS DECIMAL(10,2)) AS DistanciaKm
        FROM dbo.Fisioterapeutas f
        JOIN dbo.Localizacoes l ON l.FisioterapeutaId = f.Id
        CROSS APPLY (SELECT l.GeoLocalizacao.STDistance(@Ponto) AS DistM) d
        WHERE
          f.Ativo = 1
          AND l.GeoLocalizacao IS NOT NULL
          AND d.DistM <= (@RaioBuscaKm * 1000.0)
          AND d.DistM <= (l.RaioAtendimentoKm * 1000.0)
      )
      SELECT COUNT(1) AS Total FROM Base;

      ;WITH Base AS (
        SELECT
          f.Id AS FisioterapeutaId,
          f.Nome,
          l.Cidade,
          l.Estado,
          l.RaioAtendimentoKm,
          CAST(d.DistM / 1000.0 AS DECIMAL(10,2)) AS DistanciaKm
        FROM dbo.Fisioterapeutas f
        JOIN dbo.Localizacoes l ON l.FisioterapeutaId = f.Id
        CROSS APPLY (SELECT l.GeoLocalizacao.STDistance(@Ponto) AS DistM) d
        WHERE
          f.Ativo = 1
          AND l.GeoLocalizacao IS NOT NULL
          AND d.DistM <= (@RaioBuscaKm * 1000.0)
          AND d.DistM <= (l.RaioAtendimentoKm * 1000.0)
      )
      SELECT
        FisioterapeutaId,
        Nome,
        Cidade,
        Estado,
        RaioAtendimentoKm,
        DistanciaKm
      FROM Base
      ORDER BY DistanciaKm ASC, FisioterapeutaId ASC
      OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
    `;

    const result = await queryWithContext(
      contexto,
      (req) => {
        req.input('LatPaciente', sql.Decimal(9, 6), latNum);
        req.input('LonPaciente', sql.Decimal(9, 6), lonNum);
        req.input('RaioBuscaKm', sql.Decimal(6, 2), raio);
        req.input('Offset', sql.Int, paginacao.offset);
        req.input('Limit', sql.Int, paginacao.limit);
      },
      sqlText,
      { requireContext: true }
    );

    return {
      total: result?.recordsets?.[0]?.[0]?.Total ?? 0,
      limit: paginacao.limit,
      offset: paginacao.offset,
      itens: result?.recordsets?.[1] || []
    };
  },
};

export default localizacoesService;


