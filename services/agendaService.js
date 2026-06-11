// 📁 services/agendaService.js
import { sql } from '../config/dbConfig.js';
import { queryWithContext } from './_queryWithContext.js';
import { HttpError } from '../utils/httpError.js';

const NOTAS_MAX_LENGTH = 500;
const MOTIVO_MAX_LENGTH = 500;
const APP_TIME_ZONE = 'America/Sao_Paulo';

function assertId(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${label} inválido.`);
  return n;
}

function assertDiaSemana(dia) {
  const n = Number(dia);
  if (!Number.isInteger(n) || n < 0 || n > 6) throw new HttpError(400, 'DiaSemana inválido (use 0..6).');
  return n;
}

function assertTimeStr(t, label) {
  // Aceita:
  //  - Date (já vindo do banco)
  //  - string "HH:mm" ou "HH:mm:ss" (opcionalmente com frações)
  if (t instanceof Date) return t;

  if (!t || typeof t !== 'string') {
    throw new HttpError(400, `${label} inválido. Use HH:mm ou HH:mm:ss`);
  }

  const s = t.trim();
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,7})?)?$/.exec(s);
  if (!match) {
    throw new HttpError(400, `${label} inválido. Use HH:mm ou HH:mm:ss`);
  }

  const [, hhStr, mmStr, ssStrRaw] = match;
  const hh = Number(hhStr);
  const mm = Number(mmStr);
  const ss = Number(ssStrRaw ?? '0');

  if (
    !Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss) ||
    hh < 0 || hh > 23 ||
    mm < 0 || mm > 59 ||
    ss < 0 || ss > 59
  ) {
    throw new HttpError(400, `${label} inválido. Use HH:mm ou HH:mm:ss`);
  }

  // Criamos um Date "fake" em 1970-01-01 UTC, só para representar o horário.
  // Isso é compatível com o tipo TIME do SQL Server no driver mssql.
  const date = new Date(Date.UTC(1970, 0, 1, hh, mm, ss, 0));
  return date;
}


function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function timeToHHMM(v) {
  if (v === null || v === undefined) return v;

  // Driver mssql costuma devolver TIME como Date ancorado em 1970-01-01.
  // Para evitar “ano 1970” na API, devolvemos como "HH:mm".
  if (v instanceof Date) {
    return `${pad2(v.getUTCHours())}:${pad2(v.getUTCMinutes())}`;
  }

  if (typeof v === 'string') {
    const m = /^(\d{2}):(\d{2})/.exec(v.trim());
    if (m) return `${m[1]}:${m[2]}`;
  }

  return v;
}

function extractAppLocalDateTimeParts(value) {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
      hour: value.getUTCHours(),
      minute: value.getUTCMinutes(),
      second: value.getUTCSeconds(),
      millisecond: value.getUTCMilliseconds()
    };
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw
    .replace(/Z$/i, '')
    .replace(/([+-]\d{2}:\d{2})$/, '')
    .replace(' ', 'T');

  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,7}))?/
  );
  if (!match) return null;

  const fraction = String(match[7] ?? '').padEnd(3, '0').slice(0, 3);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? '0'),
    millisecond: Number(fraction || '0')
  };
}

function formatAppLocalDateTime(value) {
  const parts = extractAppLocalDateTimeParts(value);
  if (!parts) return null;

  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}.${pad3(parts.millisecond)}`;
}

function mapAgendaRow(row) {
  return {
    ...row,
    HoraInicio: timeToHHMM(row.HoraInicio),
    HoraFim: timeToHHMM(row.HoraFim)
  };
}

function mapBloqueioRow(row) {
  if (!row) return row;

  return {
    ...row,
    DataInicio: formatAppLocalDateTime(row.DataInicio),
    DataFim: formatAppLocalDateTime(row.DataFim),
    CriadoEm: formatAppLocalDateTime(row.CriadoEm)
  };
}

function getSqlErrorMessage(err) {
  return String(
    err?.originalError?.info?.message ||
    err?.originalError?.message ||
    err?.message ||
    ''
  );
}

function toBit(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === 1 || v === 0) return v;
  if (v === '1' || v === '0') return Number(v);
  throw new HttpError(400, 'Ativo inválido (use true/false ou 1/0).');
}

function parseOverwriteConflictsFlag(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === 1 || v === 0) return v;
  if (typeof v === 'string') {
    const normalized = v.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') return 1;
    if (normalized === '0' || normalized === 'false') return 0;
  }
  throw new HttpError(400, 'SobrescreverConflitos inválido (use true/false ou 1/0).');
}

function parseValidationOnlyFlag(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === 1 || v === 0) return v;
  if (typeof v === 'string') {
    const normalized = v.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') return 1;
    if (normalized === '0' || normalized === 'false') return 0;
  }
  throw new HttpError(400, 'validarApenas inválido (use true/false ou 1/0).');
}

function parseReplaceDayFlag(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === 1 || v === 0) return v;
  if (typeof v === 'string') {
    const normalized = v.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') return 1;
    if (normalized === '0' || normalized === 'false') return 0;
  }
  throw new HttpError(400, 'SubstituirDia inválido (use true/false ou 1/0).');
}

function sanitizeNotas(notas) {
  if (notas === undefined) return undefined;
  if (notas === null) return null;
  if (typeof notas !== 'string') throw new HttpError(400, 'Notas deve ser texto.');
  const s = notas.trim();
  if (!s) return null;
  if (s.length > NOTAS_MAX_LENGTH) throw new HttpError(400, `Notas excede ${NOTAS_MAX_LENGTH} caracteres.`);
  return s;
}

function sanitizeMotivo(motivo) {
  if (motivo === undefined) return undefined;
  if (motivo === null) return null;
  if (typeof motivo !== 'string') throw new HttpError(400, 'Motivo deve ser texto.');
  const s = motivo.trim();
  if (!s) return null;
  if (s.length > MOTIVO_MAX_LENGTH) throw new HttpError(400, `Motivo excede ${MOTIVO_MAX_LENGTH} caracteres.`);
  return s;
}

function assertRange(de, ate) {
  const d = new Date(de);
  const a = new Date(ate);
  if (Number.isNaN(d.getTime()) || Number.isNaN(a.getTime())) {
    throw new HttpError(400, 'Parâmetros de/ate inválidos.');
  }
  if (!(d < a)) throw new HttpError(400, 'Parâmetro de deve ser menor que ate.');
  const diffDays = (a.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays > 93) throw new HttpError(400, 'Range muito grande. Use no máximo ~90 dias por consulta.');
  return { deDate: d, ateDate: a };
}

function parseOptionalDate(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const raw = String(value).trim();
  // Strings de data pura (YYYY-MM-DD) devem ser tratadas como data local,
  // não como UTC midnight, para evitar deslocamento de dia pelo timezone do servidor.
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00` : raw;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) {
    throw new HttpError(400, `${label} inválido.`);
  }
  return d;
}

function parseOptionalDateTimeBoundary(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  const raw = String(value).trim();
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const parsed = new Date(Date.UTC(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
      0,
      0,
      0,
      0
    ));
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, `${label} inválido.`);
    }
    return parsed;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, `${label} inválido.`);
  }
  return parsed;
}

function parseDateOnlyString(value, label = 'Data') {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new HttpError(400, `${label} inválida. Use YYYY-MM-DD.`);
  }
  const d = new Date(`${raw}T12:00:00`);
  if (Number.isNaN(d.getTime())) {
    throw new HttpError(400, `${label} inválida. Use YYYY-MM-DD.`);
  }
  return raw;
}

// Converte "YYYY-MM-DDTHH:mm:ss" (com ou sem offset) para um Date UTC-naive,
// preservando o horário de parede enviado pelo app e evitando shift do timezone
// do servidor/driver ao gravar datetime no SQL Server.
function parseLocalIsoToUtcNaive(value, label = 'DataHora') {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new HttpError(400, `${label} inválida.`);
    return value;
  }

  if (typeof value === 'string') {
    const raw = value.trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (match) {
      const parsed = new Date(Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6] ?? '0'),
        0
      ));
      if (Number.isNaN(parsed.getTime())) throw new HttpError(400, `${label} inválida.`);
      return parsed;
    }
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(400, `${label} inválida.`);
  return parsed;
}

function timeStrToMinutes(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTimeStr(totalMinutes) {
  const normalized = Math.max(0, Math.min(totalMinutes, 24 * 60));
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${pad2(hours)}:${pad2(minutes)}`;
}

function mergeMinuteRanges(ranges, { mergeTouching = true } = {}) {
  const sorted = [...ranges]
    .filter((range) => Number.isFinite(range?.start) && Number.isFinite(range?.end) && range.start < range.end)
    .sort((a, b) => a.start - b.start);

  return sorted.reduce((acc, range) => {
    const last = acc[acc.length - 1];
    if (!last) {
      acc.push({ ...range });
      return acc;
    }

    if (range.start < last.end || (mergeTouching && range.start === last.end)) {
      last.end = Math.max(last.end, range.end);
      return acc;
    }

    acc.push({ ...range });
    return acc;
  }, []);
}

function normalizeMinuteRanges(ranges, { mergeTouching = true } = {}) {
  const sorted = [...ranges]
    .filter((range) => Number.isFinite(range?.start) && Number.isFinite(range?.end) && range.start < range.end)
    .sort((a, b) => a.start - b.start);

  return sorted.reduce((acc, range) => {
    const last = acc[acc.length - 1];
    if (!last) {
      acc.push({ ...range });
      return acc;
    }

    if (range.start < last.end) {
      throw new HttpError(400, 'Os intervalos da exceção não podem se sobrepor.');
    }

    if (mergeTouching && range.start === last.end) {
      last.end = Math.max(last.end, range.end);
      return acc;
    }

    acc.push({ ...range });
    return acc;
  }, []);
}

function normalizeExcecaoIntervalosPayload(intervalos) {
  if (!Array.isArray(intervalos)) {
    throw new HttpError(400, 'Intervalos inválidos. Envie uma lista de horários.');
  }

  const baseRanges = intervalos.map((item) => {
    const horaInicio = timeToHHMM(assertTimeStr(item?.horaInicio ?? item?.HoraInicio, 'HoraInicio'));
    const horaFim = timeToHHMM(assertTimeStr(item?.horaFim ?? item?.HoraFim, 'HoraFim'));
    const start = timeStrToMinutes(horaInicio);
    const end = timeStrToMinutes(horaFim);

    if (!(start < end)) {
      throw new HttpError(400, 'HoraInicio deve ser menor que HoraFim.');
    }

    return { start, end };
  });

  return normalizeMinuteRanges(baseRanges, { mergeTouching: true }).map((range) => ({
    horaInicio: minutesToTimeStr(range.start),
    horaFim: minutesToTimeStr(range.end)
  }));
}

function subtractMinuteRanges(baseRanges, blockedRanges) {
  const normalizedBase = mergeMinuteRanges(baseRanges, { mergeTouching: true });
  const normalizedBlocked = mergeMinuteRanges(blockedRanges, { mergeTouching: true });

  return normalizedBase.flatMap((base) => {
    let remaining = [{ ...base }];

    normalizedBlocked.forEach((blocked) => {
      remaining = remaining.flatMap((segment) => {
        if (blocked.end <= segment.start || blocked.start >= segment.end) {
          return [segment];
        }

        const parts = [];
        if (blocked.start > segment.start) {
          parts.push({ start: segment.start, end: blocked.start });
        }
        if (blocked.end < segment.end) {
          parts.push({ start: blocked.end, end: segment.end });
        }
        return parts.filter((part) => part.start < part.end);
      });
    });

    return remaining;
  });
}

function groupExcecoesRows(rows) {
  const map = new Map();

  (rows || []).forEach((row) => {
    const exceptionId = Number(row.ExcecaoId ?? row.Id ?? 0);
    if (!exceptionId) return;

    if (!map.has(exceptionId)) {
      map.set(exceptionId, {
        Id: exceptionId,
        FisioterapeutaId: row.FisioterapeutaId,
        Data: row.Data,
        DiaSemDisponibilidade: row.DiaSemDisponibilidade === true || row.DiaSemDisponibilidade === 1,
        Notas: row.Notas ?? null,
        CriadoEm: formatAppLocalDateTime(row.CriadoEm),
        AtualizadoEm: formatAppLocalDateTime(row.AtualizadoEm),
        Intervalos: []
      });
    }

    if (row.IntervaloId != null) {
      map.get(exceptionId).Intervalos.push({
        Id: Number(row.IntervaloId),
        HoraInicio: timeToHHMM(row.HoraInicio),
        HoraFim: timeToHHMM(row.HoraFim)
      });
    }
  });

  return Array.from(map.values()).map((item) => ({
    ...item,
    Intervalos: item.Intervalos.sort((a, b) => a.HoraInicio.localeCompare(b.HoraInicio))
  }));
}

async function listarExcecoesNoPeriodo(usuario, fisioterapeutaId, { deDate = null, ateDate = null } = {}) {
  const result = await queryWithContext(usuario, (req) => {
    req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    req.input('De', sql.Date, deDate);
    req.input('Ate', sql.Date, ateDate);
  }, `
    SELECT
      e.Id AS ExcecaoId,
      e.FisioterapeutaId,
      CONVERT(varchar(10), e.Data, 23) AS Data,
      e.DiaSemDisponibilidade,
      e.Notas,
      e.CriadoEm,
      e.AtualizadoEm,
      i.Id AS IntervaloId,
      i.HoraInicio,
      i.HoraFim
    FROM dbo.AgendasExcecoesDia e
    LEFT JOIN dbo.AgendasExcecoesDiaIntervalos i
      ON i.ExcecaoDiaId = e.Id
    WHERE e.FisioterapeutaId = @FisioterapeutaId
      AND (@De IS NULL OR e.Data >= @De)
      AND (@Ate IS NULL OR e.Data <  @Ate)
    ORDER BY e.Data ASC, i.HoraInicio ASC, i.Id ASC;
  `, { requireContext: true });

  return groupExcecoesRows(result.recordset || []);
}

async function obterExcecaoPorId(usuario, fisioterapeutaId, excecaoId) {
  const id = assertId(excecaoId, 'ExcecaoId');
  const result = await queryWithContext(usuario, (req) => {
    req.input('Id', sql.Int, id);
    req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
  }, `
    SELECT
      e.Id AS ExcecaoId,
      e.FisioterapeutaId,
      CONVERT(varchar(10), e.Data, 23) AS Data,
      e.DiaSemDisponibilidade,
      e.Notas,
      e.CriadoEm,
      e.AtualizadoEm,
      i.Id AS IntervaloId,
      i.HoraInicio,
      i.HoraFim
    FROM dbo.AgendasExcecoesDia e
    LEFT JOIN dbo.AgendasExcecoesDiaIntervalos i
      ON i.ExcecaoDiaId = e.Id
    WHERE e.Id = @Id
      AND e.FisioterapeutaId = @FisioterapeutaId
    ORDER BY i.HoraInicio ASC, i.Id ASC;
  `, { requireContext: true });

  return groupExcecoesRows(result.recordset || [])[0] ?? null;
}

async function obterExcecaoPorData(usuario, fisioterapeutaId, dataStr) {
  const result = await queryWithContext(usuario, (req) => {
    req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    req.input('Data', sql.Date, dataStr);
  }, `
    SELECT
      e.Id AS ExcecaoId,
      e.FisioterapeutaId,
      CONVERT(varchar(10), e.Data, 23) AS Data,
      e.DiaSemDisponibilidade,
      e.Notas,
      e.CriadoEm,
      e.AtualizadoEm,
      i.Id AS IntervaloId,
      i.HoraInicio,
      i.HoraFim
    FROM dbo.AgendasExcecoesDia e
    LEFT JOIN dbo.AgendasExcecoesDiaIntervalos i
      ON i.ExcecaoDiaId = e.Id
    WHERE e.FisioterapeutaId = @FisioterapeutaId
      AND e.Data = @Data
    ORDER BY i.HoraInicio ASC, i.Id ASC;
  `, { requireContext: true });

  return groupExcecoesRows(result.recordset || [])[0] ?? null;
}

async function carregarSuporteDisponibilidadeDia(usuario, fisioterapeutaId, dataStr) {
  const dbDiaSemana = new Date(`${dataStr}T12:00:00`).getDay();
  const dayStart = new Date(`${dataStr}T00:00:00`);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const [rotinaResult, bloqueiosResult, consultasResult] = await Promise.all([
    queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      req.input('DiaSemana', sql.TinyInt, dbDiaSemana);
    }, `
      SELECT Id, HoraInicio, HoraFim, Notas
      FROM dbo.AgendasFisioterapeutas
      WHERE FisioterapeutaId = @FisioterapeutaId
        AND DiaSemana = @DiaSemana
        AND Ativo = 1
      ORDER BY HoraInicio ASC, Id ASC;
    `, { requireContext: true }),
    queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      req.input('DayStart', sql.DateTime, dayStart);
      req.input('DayEnd', sql.DateTime, dayEnd);
    }, `
      SELECT Id, DataInicio, DataFim
      FROM dbo.HorariosBloqueados
      WHERE FisioterapeutaId = @FisioterapeutaId
        AND DataInicio < @DayEnd
        AND DataFim > @DayStart
      ORDER BY DataInicio ASC, Id ASC;
    `, { requireContext: true }),
    queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      req.input('DayStart', sql.DateTime, dayStart);
      req.input('DayEnd', sql.DateTime, dayEnd);
      bindConsultaStatusAtivo(req);
    }, `
      SELECT Id, DataHora
      FROM dbo.Consultas
      WHERE FisioterapeutaId = @FisioterapeutaId
        ${CONSULTA_STATUS_ATIVO_WHERE}
        AND DataHora >= CASE WHEN @DayStart > SYSDATETIME() THEN @DayStart ELSE SYSDATETIME() END
        AND DataHora <  @DayEnd
      ORDER BY DataHora ASC, Id ASC;
    `, { requireContext: true }),
  ]);

  const rotinaRanges = (rotinaResult.recordset || []).map((item) => ({
    start: timeStrToMinutes(timeToHHMM(item.HoraInicio)),
    end: timeStrToMinutes(timeToHHMM(item.HoraFim))
  }));

  const blockedRanges = (bloqueiosResult.recordset || []).reduce((acc, item) => {
    const dataInicio = item.DataInicio instanceof Date ? item.DataInicio : new Date(item.DataInicio);
    const dataFim = item.DataFim instanceof Date ? item.DataFim : new Date(item.DataFim);
    if (Number.isNaN(dataInicio.getTime()) || Number.isNaN(dataFim.getTime())) return acc;

    const start = Math.max(dataInicio.getTime(), dayStart.getTime());
    const end = Math.min(dataFim.getTime(), dayEnd.getTime());
    if (!(start < end)) return acc;

    const startDate = new Date(start);
    const endDate = new Date(end);
    acc.push({
      start: startDate.getUTCHours() * 60 + startDate.getUTCMinutes(),
      end: endDate.getUTCHours() * 60 + endDate.getUTCMinutes()
    });
    return acc;
  }, []);

  const consultas = (consultasResult.recordset || []).map((item) => {
    const dataHora = item.DataHora instanceof Date ? item.DataHora : new Date(item.DataHora);
    return {
      id: item.Id,
      minutos: dataHora.getUTCHours() * 60 + dataHora.getUTCMinutes()
    };
  });

  return {
    rotinaRanges: mergeMinuteRanges(rotinaRanges, { mergeTouching: false }),
    blockedRanges: mergeMinuteRanges(blockedRanges, { mergeTouching: true }),
    consultas
  };
}

async function assertConsultasCompativeisComDisponibilidadeDia(usuario, fisioterapeutaId, dataStr, baseIntervalos) {
  const suporte = await carregarSuporteDisponibilidadeDia(usuario, fisioterapeutaId, dataStr);
  const baseRanges = normalizeMinuteRanges(
    (baseIntervalos || []).map((item) => ({
      start: timeStrToMinutes(item.horaInicio),
      end: timeStrToMinutes(item.horaFim)
    })),
    { mergeTouching: true }
  );
  const effectiveRanges = subtractMinuteRanges(baseRanges, suporte.blockedRanges);

  const hasCoverage = (minutes) =>
    effectiveRanges.some((range) => minutes >= range.start && minutes < range.end);

  if (suporte.consultas.some((consulta) => !hasCoverage(consulta.minutos))) {
    throw new HttpError(409, 'Conflito: existe consulta futura em horário que ficaria fora da disponibilidade deste dia.');
  }
}


// 🟩 Rotina padrão (auto): evita fisio ter que “criar rotina” para conseguir receber agendamentos.
// Ajuste aqui se quiser outro horário padrão.
const ROTINA_PADRAO_AUTO = {
  horaInicio: '08:00',
  horaFim: '18:00',
  ativo: 1,
  notas: null
};

async function ensureRotinaPadraoSeVazia(usuario, fisioterapeutaId) {
  // Cria 1 intervalo por dia (0..6) se o fisio ainda não tem nenhum registro de rotina.
  // Usa transação explícita + UPDLOCK/HOLDLOCK para evitar duplicar em chamadas concorrentes.
  await queryWithContext(usuario, (req) => {
    req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    req.input('HoraInicioPadrao', sql.Time, assertTimeStr(ROTINA_PADRAO_AUTO.horaInicio, 'HoraInicio padrão'));
    req.input('HoraFimPadrao', sql.Time, assertTimeStr(ROTINA_PADRAO_AUTO.horaFim, 'HoraFim padrão'));
    req.input('AtivoPadrao', sql.Bit, toBit(ROTINA_PADRAO_AUTO.ativo));
    req.input('NotasPadrao', sql.NVarChar(NOTAS_MAX_LENGTH), sanitizeNotas(ROTINA_PADRAO_AUTO.notas));
  }, `
    BEGIN TRY
      BEGIN TRAN;

      IF EXISTS (SELECT 1 FROM dbo.Fisioterapeutas WHERE Id = @FisioterapeutaId)
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM dbo.AgendasFisioterapeutas WITH (UPDLOCK, HOLDLOCK)
          WHERE FisioterapeutaId = @FisioterapeutaId
        )
        BEGIN
          INSERT INTO dbo.AgendasFisioterapeutas (FisioterapeutaId, DiaSemana, HoraInicio, HoraFim, Ativo, Notas)
          VALUES
            (@FisioterapeutaId, 1, @HoraInicioPadrao, @HoraFimPadrao, @AtivoPadrao, @NotasPadrao),
            (@FisioterapeutaId, 2, @HoraInicioPadrao, @HoraFimPadrao, @AtivoPadrao, @NotasPadrao),
            (@FisioterapeutaId, 3, @HoraInicioPadrao, @HoraFimPadrao, @AtivoPadrao, @NotasPadrao),
            (@FisioterapeutaId, 4, @HoraInicioPadrao, @HoraFimPadrao, @AtivoPadrao, @NotasPadrao),
            (@FisioterapeutaId, 5, @HoraInicioPadrao, @HoraFimPadrao, @AtivoPadrao, @NotasPadrao);
        END
      END

      COMMIT TRAN;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0
        ROLLBACK TRAN;
      THROW;
    END CATCH
  `, { requireContext: true });
}

function isNotaPayload(payload = {}) {
  const tipoItem = String(payload?.tipoItem ?? payload?.TipoItem ?? '').trim().toLowerCase();
  return tipoItem === 'nota' || payload?.texto !== undefined || payload?.Texto !== undefined;
}

function getTextoNota(payload = {}) {
  if (payload?.texto !== undefined) return payload.texto;
  if (payload?.Texto !== undefined) return payload.Texto;
  if (payload?.notas !== undefined) return payload.notas;
  if (payload?.Notas !== undefined) return payload.Notas;
  return undefined;
}

async function criarNotaRotina(usuario, fisioterapeutaId, payload = {}) {
  const d = assertDiaSemana(payload?.diaSemana ?? payload?.DiaSemana);
  const texto = sanitizeNotas(getTextoNota(payload));

  if (!texto) {
    throw new HttpError(400, 'Texto da anotação é obrigatório.');
  }

  await ensureRotinaPadraoSeVazia(usuario, fisioterapeutaId);

  await queryWithContext(usuario, (req) => {
    req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    req.input('DiaSemana', sql.TinyInt, d);
    req.input('Notas', sql.NVarChar(NOTAS_MAX_LENGTH), texto);
    req.input('HoraInicioPadrao', sql.Time, assertTimeStr(ROTINA_PADRAO_AUTO.horaInicio, 'HoraInicio padrão'));
    req.input('HoraFimPadrao', sql.Time, assertTimeStr(ROTINA_PADRAO_AUTO.horaFim, 'HoraFim padrão'));
    req.input('AtivoNotaPadrao', sql.Bit, 0);
  }, `
    IF NOT EXISTS (
      SELECT 1
      FROM dbo.AgendasFisioterapeutas WITH (UPDLOCK, HOLDLOCK)
      WHERE FisioterapeutaId = @FisioterapeutaId
        AND DiaSemana = @DiaSemana
    )
    BEGIN
      INSERT INTO dbo.AgendasFisioterapeutas
        (FisioterapeutaId, DiaSemana, HoraInicio, HoraFim, Ativo, Notas)
      VALUES
        (@FisioterapeutaId, @DiaSemana, @HoraInicioPadrao, @HoraFimPadrao, @AtivoNotaPadrao, @Notas);
    END
    ELSE
    BEGIN
      UPDATE dbo.AgendasFisioterapeutas
      SET Notas = @Notas
      WHERE Id = (
        SELECT TOP 1 Id
        FROM dbo.AgendasFisioterapeutas
        WHERE FisioterapeutaId = @FisioterapeutaId
          AND DiaSemana = @DiaSemana
        ORDER BY
          CASE WHEN ISNULL(Ativo, 0) = 1 THEN 0 ELSE 1 END,
          HoraInicio ASC,
          Id ASC
      );
    END
  `, { requireContext: true });

  const result = await queryWithContext(usuario, (req) => {
    req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    req.input('DiaSemana', sql.TinyInt, d);
  }, `
    SELECT TOP 1
      Id,
      FisioterapeutaId,
      DiaSemana,
      HoraInicio,
      HoraFim,
      Ativo,
      DataCriacao,
      Notas
    FROM dbo.AgendasFisioterapeutas
    WHERE FisioterapeutaId = @FisioterapeutaId
      AND DiaSemana = @DiaSemana
    ORDER BY
      CASE WHEN ISNULL(Ativo, 0) = 1 THEN 0 ELSE 1 END,
      HoraInicio ASC,
      Id ASC;
  `, { requireContext: true });

  const row = result.recordset?.[0] ?? null;
  if (!row) {
    throw new HttpError(404, 'Não foi possível localizar a rotina deste dia para salvar a anotação.');
  }

  return mapAgendaRow(row);
}

async function atualizarNotaRotina(usuario, fisioterapeutaId, agendaId, payload = {}) {
  const texto = sanitizeNotas(getTextoNota(payload));

  await queryWithContext(usuario, (req) => {
    req.input('Id', sql.Int, agendaId);
    req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    req.input('Notas', sql.NVarChar(NOTAS_MAX_LENGTH), texto ?? null);
  }, `
    UPDATE dbo.AgendasFisioterapeutas
    SET Notas = @Notas
    WHERE Id = @Id
      AND FisioterapeutaId = @FisioterapeutaId;
  `, { requireContext: true });

  const result = await queryWithContext(usuario, (req) => {
    req.input('Id', sql.Int, agendaId);
    req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
  }, `
    SELECT TOP 1
      Id,
      FisioterapeutaId,
      DiaSemana,
      HoraInicio,
      HoraFim,
      Ativo,
      DataCriacao,
      Notas
    FROM dbo.AgendasFisioterapeutas
    WHERE Id = @Id
      AND FisioterapeutaId = @FisioterapeutaId;
  `, { requireContext: true });

  const row = result.recordset?.[0] ?? null;
  if (!row) {
    throw new HttpError(404, 'Anotação não encontrada ou sem permissão.');
  }

  return mapAgendaRow(row);
}



/* ------------------------- Consultas: regras e listagem (DataHora) ------------------------- */

const CONSULTA_STATUS_ATIVO_WHERE = `
  AND ISNULL(Status, N'') NOT IN (@StatusCancelada, @StatusConcluida)
`;

function bindConsultaStatusAtivo(req) {
  req.input('StatusCancelada', sql.NVarChar(30), 'Cancelada');
  req.input('StatusConcluida', sql.NVarChar(30), 'Concluída');
}

const CONSULTA_STATUS_BLOQUEIO_WHERE = `
  AND ISNULL(Status, N'') NOT IN (
    @StatusCancelada,
    @StatusConcluida,
    @StatusFisioAusente,
    @StatusPacienteAusente
  )
`;

function bindConsultaStatusBloqueio(req) {
  req.input('StatusCancelada', sql.NVarChar(60), 'Cancelada');
  req.input('StatusConcluida', sql.NVarChar(60), 'Concluída');
  req.input('StatusFisioAusente', sql.NVarChar(60), 'Fisioterapeuta Ausente');
  req.input('StatusPacienteAusente', sql.NVarChar(60), 'Paciente Ausente');
}

async function assertSemConsultaFuturaNoSlot(usuario, fisioterapeutaId, diaSemana, horaInicio, horaFim) {
  const result = await queryWithContext(usuario, (req) => {
    req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    req.input('DiaSemana', sql.TinyInt, diaSemana);
    req.input('HoraInicio', sql.Time, horaInicio);
    req.input('HoraFim', sql.Time, horaFim);
    bindConsultaStatusAtivo(req);
  }, `
    SELECT TOP 1 Id
    FROM dbo.Consultas
    WHERE FisioterapeutaId = @FisioterapeutaId
      ${CONSULTA_STATUS_ATIVO_WHERE}
      AND DataHora >= SYSDATETIME()
      AND ((DATEPART(WEEKDAY, DataHora) + @@DATEFIRST - 1) % 7) = @DiaSemana
      AND (
        CONVERT(time, DataHora) >= CONVERT(time, @HoraInicio)
        AND CONVERT(time, DataHora) <  CONVERT(time, @HoraFim)
      );
  `);

  if (result.recordset?.length) {
    throw new HttpError(409, 'Conflito: existe consulta futura marcada dentro desse intervalo semanal.');
  }
}

const agendaService = {
  /* --------------------------- AGENDA SEMANAL (CRUD) --------------------------- */

  async listarMinhaAgenda(usuario) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');

    // Se ainda não tiver rotina cadastrada, cria uma rotina padrão automaticamente
    await ensureRotinaPadraoSeVazia(usuario, fisioterapeutaId);

    const result = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    }, `
      SELECT
        Id, FisioterapeutaId, DiaSemana, HoraInicio, HoraFim, Ativo, DataCriacao, Notas
      FROM dbo.AgendasFisioterapeutas
      WHERE FisioterapeutaId = @FisioterapeutaId
      ORDER BY DiaSemana ASC, HoraInicio ASC, Id ASC;
    `, { requireContext: true });

    return (result.recordset || []).map(mapAgendaRow);
  },

  async criarAgenda(usuario, payload = {}) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');

    if (isNotaPayload(payload)) {
      return criarNotaRotina(usuario, fisioterapeutaId, payload);
    }

    const { diaSemana, horaInicio, horaFim, ativo = 1, notas = null } = payload;
    const sobrescreverConflitos = parseOverwriteConflictsFlag(
      payload?.sobrescreverConflitos ?? payload?.SobrescreverConflitos ?? payload?.overwriteConflicts
    );
    const substituirDia = parseReplaceDayFlag(
      payload?.substituirDia ?? payload?.SubstituirDia ?? payload?.replaceEntireDay
    );

    const d = assertDiaSemana(diaSemana);
    const hi = assertTimeStr(horaInicio, 'HoraInicio'); // agora vira Date (1970-01-01 HH:mm:ssZ)
    const hf = assertTimeStr(horaFim, 'HoraFim');       // idem
    const isAtivo = toBit(ativo);
    const nNotas = sanitizeNotas(notas);

    if (!(hi < hf)) throw new HttpError(400, 'HoraInicio deve ser menor que HoraFim.');

    try {
      const result = await queryWithContext(usuario, (req) => {
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
        req.input('DiaSemana', sql.TinyInt, d);
        req.input('HoraInicio', sql.Time, hi);
        req.input('HoraFim', sql.Time, hf);
        req.input('Ativo', sql.Bit, isAtivo);
        req.input('Notas', sql.NVarChar(NOTAS_MAX_LENGTH), nNotas);
        req.input('SobrescreverConflitos', sql.Bit, sobrescreverConflitos);
        req.input('SubstituirDia', sql.Bit, substituirDia);
        bindConsultaStatusAtivo(req);
      }, `
        BEGIN TRY
          BEGIN TRAN;

          DECLARE @Conflitos TABLE (
            Id INT PRIMARY KEY,
            HoraInicio TIME,
            HoraFim TIME
          );

          IF @Ativo = 1
          BEGIN
            INSERT INTO @Conflitos (Id, HoraInicio, HoraFim)
            SELECT Id, HoraInicio, HoraFim
            FROM dbo.AgendasFisioterapeutas WITH (UPDLOCK, HOLDLOCK)
            WHERE FisioterapeutaId = @FisioterapeutaId
              AND DiaSemana = @DiaSemana
              AND Ativo = 1
              AND (
                ISNULL(@SubstituirDia, 0) = 1
                OR (@HoraInicio < HoraFim AND @HoraFim > HoraInicio)
              );
          END

          IF @Ativo = 1
             AND EXISTS (SELECT 1 FROM @Conflitos)
             AND ISNULL(@SobrescreverConflitos, 0) = 0
             AND ISNULL(@SubstituirDia, 0) = 0
          BEGIN
            RAISERROR(N'Conflito: já existe intervalo ativo que sobrepõe este horário.', 16, 1);
          END

          IF @Ativo = 1
             AND EXISTS (SELECT 1 FROM @Conflitos)
             AND (ISNULL(@SobrescreverConflitos, 0) = 1 OR ISNULL(@SubstituirDia, 0) = 1)
          BEGIN
            IF EXISTS (
              SELECT 1
              FROM dbo.Consultas WITH (UPDLOCK, HOLDLOCK)
              WHERE FisioterapeutaId = @FisioterapeutaId
                ${CONSULTA_STATUS_ATIVO_WHERE}
                AND DataHora >= SYSDATETIME()
                AND ((DATEPART(WEEKDAY, DataHora) + @@DATEFIRST - 1) % 7) = @DiaSemana
                AND EXISTS (
                  SELECT 1
                  FROM @Conflitos c
                  WHERE CONVERT(time, DataHora) >= CONVERT(time, c.HoraInicio)
                    AND CONVERT(time, DataHora) <  CONVERT(time, c.HoraFim)
                )
                AND NOT (
                  CONVERT(time, DataHora) >= CONVERT(time, @HoraInicio)
                  AND CONVERT(time, DataHora) <  CONVERT(time, @HoraFim)
                )
            )
            BEGIN
              RAISERROR(N'Conflito: existe consulta futura em horário que ficaria fora do novo intervalo.', 16, 1);
            END

            DELETE FROM dbo.AgendasFisioterapeutas
            WHERE Id IN (SELECT Id FROM @Conflitos);
          END

          DECLARE @NovoId INT;

          INSERT INTO dbo.AgendasFisioterapeutas (FisioterapeutaId, DiaSemana, HoraInicio, HoraFim, Ativo, Notas)
          VALUES (@FisioterapeutaId, @DiaSemana, @HoraInicio, @HoraFim, @Ativo, @Notas);

          SET @NovoId = SCOPE_IDENTITY();

          COMMIT;

          SELECT Id, FisioterapeutaId, DiaSemana, HoraInicio, HoraFim, Ativo, DataCriacao, Notas
          FROM dbo.AgendasFisioterapeutas
          WHERE Id = @NovoId;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          THROW;
        END CATCH
      `, { requireContext: true });

      return result.recordset?.[0] ? mapAgendaRow(result.recordset[0]) : null;
    } catch (err) {
      const message = getSqlErrorMessage(err);
      if (message.includes('Conflito: já existe intervalo ativo que sobrepõe este horário.')) {
        throw new HttpError(409, 'Conflito: já existe intervalo ativo que sobrepõe este horário.');
      }
      if (message.includes('Conflito: existe consulta futura em horário que ficaria fora do novo intervalo.')) {
        throw new HttpError(409, 'Conflito: existe consulta futura em horário que ficaria fora do novo intervalo.');
      }
      throw err;
    }
  },

  async atualizarAgenda(usuario, agendaId, payload = {}) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');
    const id = assertId(agendaId, 'agendaId');

    if (isNotaPayload(payload)) {
      return atualizarNotaRotina(usuario, fisioterapeutaId, id, payload);
    }

    const { diaSemana, horaInicio, horaFim, ativo, notas } = payload;

    const atual = await queryWithContext(usuario, (req) => {
      req.input('Id', sql.Int, id);
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    }, `
      SELECT TOP 1 *
      FROM dbo.AgendasFisioterapeutas
      WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;
    `, { requireContext: true });

    const row = atual.recordset?.[0];
    if (!row) throw new HttpError(404, 'Agenda não encontrada ou sem permissão.');

    const d = diaSemana === undefined ? row.DiaSemana : assertDiaSemana(diaSemana);
    const hi = horaInicio === undefined ? row.HoraInicio : assertTimeStr(horaInicio, 'HoraInicio');
    const hf = horaFim === undefined ? row.HoraFim : assertTimeStr(horaFim, 'HoraFim');
    const isAtivo = ativo === undefined ? (row.Ativo ? 1 : 0) : toBit(ativo);
    const nNotas = notas === undefined ? row.Notas : sanitizeNotas(notas);

    if (!(hi < hf)) throw new HttpError(400, 'HoraInicio deve ser menor que HoraFim.');

    try {
      const result = await queryWithContext(usuario, (req) => {
        req.input('Id', sql.Int, id);
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
        req.input('DiaSemana', sql.TinyInt, d);
        req.input('HoraInicio', sql.Time, hi);
        req.input('HoraFim', sql.Time, hf);
        req.input('Ativo', sql.Bit, isAtivo);
        req.input('Notas', sql.NVarChar(NOTAS_MAX_LENGTH), nNotas);
        bindConsultaStatusAtivo(req);
      }, `
        BEGIN TRY
          BEGIN TRAN;

          IF NOT EXISTS (
            SELECT 1
            FROM dbo.AgendasFisioterapeutas WITH (UPDLOCK, HOLDLOCK)
            WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId
          )
          BEGIN
            RAISERROR(N'Agenda não encontrada ou sem permissão.', 16, 1);
          END

          IF @Ativo = 1
             AND EXISTS (
               SELECT 1
               FROM dbo.AgendasFisioterapeutas WITH (UPDLOCK, HOLDLOCK)
               WHERE FisioterapeutaId = @FisioterapeutaId
                 AND DiaSemana = @DiaSemana
                 AND Ativo = 1
                 AND Id <> @Id
                 AND (@HoraInicio < HoraFim AND @HoraFim > HoraInicio)
             )
          BEGIN
            RAISERROR(N'Conflito: já existe intervalo ativo que sobrepõe este horário.', 16, 1);
          END

          IF @Ativo = 0
             AND EXISTS (
               SELECT 1
               FROM dbo.Consultas WITH (UPDLOCK, HOLDLOCK)
               WHERE FisioterapeutaId = @FisioterapeutaId
                 ${CONSULTA_STATUS_ATIVO_WHERE}
                 AND DataHora >= SYSDATETIME()
                 AND ((DATEPART(WEEKDAY, DataHora) + @@DATEFIRST - 1) % 7) = @DiaSemana
                 AND (
                   CONVERT(time, DataHora) >= CONVERT(time, @HoraInicio)
                   AND CONVERT(time, DataHora) <  CONVERT(time, @HoraFim)
                 )
             )
          BEGIN
            RAISERROR(N'Conflito: existe consulta futura marcada dentro desse intervalo semanal.', 16, 1);
          END

          UPDATE dbo.AgendasFisioterapeutas
          SET DiaSemana = @DiaSemana,
              HoraInicio = @HoraInicio,
              HoraFim = @HoraFim,
              Ativo = @Ativo,
              Notas = @Notas
          WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;

          SELECT TOP 1 *
          FROM dbo.AgendasFisioterapeutas
          WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;

          COMMIT;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          THROW;
        END CATCH
      `, { requireContext: true });

      return result.recordset?.[0] ? mapAgendaRow(result.recordset[0]) : null;
    } catch (err) {
      const message = getSqlErrorMessage(err);
      if (message.includes('Agenda não encontrada ou sem permissão.')) {
        throw new HttpError(404, 'Agenda não encontrada ou sem permissão.');
      }
      if (message.includes('Conflito: já existe intervalo ativo que sobrepõe este horário.')) {
        throw new HttpError(409, 'Conflito: já existe intervalo ativo que sobrepõe este horário.');
      }
      if (message.includes('Conflito: existe consulta futura marcada dentro desse intervalo semanal.')) {
        throw new HttpError(409, 'Conflito: existe consulta futura marcada dentro desse intervalo semanal.');
      }
      throw err;
    }
  },

  async excluirAgenda(usuario, agendaId, { validarApenas } = {}) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');
    const id = assertId(agendaId, 'agendaId');
    const shouldValidateOnly = parseValidationOnlyFlag(validarApenas);

    if (shouldValidateOnly) {
      const atual = await queryWithContext(usuario, (req) => {
        req.input('Id', sql.Int, id);
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      }, `
        SELECT TOP 1 Id, FisioterapeutaId, DiaSemana, HoraInicio, HoraFim, Ativo, DataCriacao, Notas
        FROM dbo.AgendasFisioterapeutas
        WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;
      `, { requireContext: true });

      const row = atual.recordset?.[0];
      if (!row) throw new HttpError(404, 'Agenda não encontrada ou sem permissão.');
      if (toBit(row.Ativo) === 1) {
        await assertSemConsultaFuturaNoSlot(usuario, fisioterapeutaId, row.DiaSemana, row.HoraInicio, row.HoraFim);
      }
      return { podeRemover: true, item: mapAgendaRow(row) };
    }

    try {
      const result = await queryWithContext(usuario, (req) => {
        req.input('Id', sql.Int, id);
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
        bindConsultaStatusAtivo(req);
      }, `
        BEGIN TRY
          BEGIN TRAN;

          DECLARE @DiaSemana TINYINT = NULL;
          DECLARE @HoraInicio TIME = NULL;
          DECLARE @HoraFim TIME = NULL;
          DECLARE @Ativo BIT = 0;

          SELECT TOP 1
            @DiaSemana = DiaSemana,
            @HoraInicio = HoraInicio,
            @HoraFim = HoraFim,
            @Ativo = CAST(ISNULL(Ativo, 0) AS BIT)
          FROM dbo.AgendasFisioterapeutas WITH (UPDLOCK, HOLDLOCK)
          WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;

          IF @DiaSemana IS NULL OR @HoraInicio IS NULL OR @HoraFim IS NULL
          BEGIN
            RAISERROR(N'Agenda não encontrada ou sem permissão.', 16, 1);
          END

          IF @Ativo = 1
             AND EXISTS (
               SELECT 1
               FROM dbo.Consultas WITH (UPDLOCK, HOLDLOCK)
               WHERE FisioterapeutaId = @FisioterapeutaId
                 ${CONSULTA_STATUS_ATIVO_WHERE}
                 AND DataHora >= SYSDATETIME()
                 AND ((DATEPART(WEEKDAY, DataHora) + @@DATEFIRST - 1) % 7) = @DiaSemana
                 AND (
                   CONVERT(time, DataHora) >= CONVERT(time, @HoraInicio)
                   AND CONVERT(time, DataHora) <  CONVERT(time, @HoraFim)
                 )
             )
          BEGIN
            RAISERROR(N'Conflito: existe consulta futura marcada dentro desse intervalo semanal.', 16, 1);
          END

          DELETE FROM dbo.AgendasFisioterapeutas
          WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;

          SELECT @@ROWCOUNT AS LinhasAfetadas;

          COMMIT;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          THROW;
        END CATCH
      `, { requireContext: true });

      return (result.recordset?.[0]?.LinhasAfetadas || 0) > 0;
    } catch (err) {
      const message = getSqlErrorMessage(err);
      if (message.includes('Agenda não encontrada ou sem permissão.')) {
        throw new HttpError(404, 'Agenda não encontrada ou sem permissão.');
      }
      if (message.includes('Conflito: existe consulta futura marcada dentro desse intervalo semanal.')) {
        throw new HttpError(409, 'Conflito: existe consulta futura marcada dentro desse intervalo semanal.');
      }
      throw err;
    }
  },

  /* ----------------------- HORÁRIOS BLOQUEADOS (CRUD) ------------------------ */

  async listarMeusBloqueios(usuario, { de, ate, limit = 100, offset = 0 } = {}) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');
    const lim = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
    const off = Math.max(Number.parseInt(offset, 10) || 0, 0);
    // Bloqueios usam DATETIME na query. Para filtros "YYYY-MM-DD",
    // precisamos de 00:00:00 do dia informado, e não do meio do dia.
    const deDate = parseOptionalDateTimeBoundary(de, 'Parâmetro de');
    const ateDate = parseOptionalDateTimeBoundary(ate, 'Parâmetro ate');

    if (deDate && ateDate && !(deDate < ateDate)) {
      throw new HttpError(400, 'Parâmetro de deve ser menor que ate.');
    }

    const result = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      req.input('De', sql.DateTime, deDate);
      req.input('Ate', sql.DateTime, ateDate);
      req.input('Limit', sql.Int, lim);
      req.input('Offset', sql.Int, off);
    }, `
      ;WITH Base AS (
      SELECT
        Id, FisioterapeutaId, DataInicio, DataFim, Motivo, CriadoEm
      FROM dbo.HorariosBloqueados
      WHERE FisioterapeutaId = @FisioterapeutaId
        AND (@De  IS NULL OR DataFim   >= @De)
        AND (@Ate IS NULL OR DataInicio <  @Ate)
      )
      SELECT COUNT(1) AS Total FROM Base;

      ;WITH Base AS (
      SELECT
        Id, FisioterapeutaId, DataInicio, DataFim, Motivo, CriadoEm
      FROM dbo.HorariosBloqueados
      WHERE FisioterapeutaId = @FisioterapeutaId
        AND (@De  IS NULL OR DataFim   >= @De)
        AND (@Ate IS NULL OR DataInicio <  @Ate)
      )
      SELECT
        Id, FisioterapeutaId, DataInicio, DataFim, Motivo, CriadoEm
      FROM Base
      ORDER BY DataInicio ASC, Id ASC
      OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;
    `);

    return {
      total: result?.recordsets?.[0]?.[0]?.Total ?? 0,
      limit: lim,
      offset: off,
      itens: (result?.recordsets?.[1] || []).map(mapBloqueioRow)
    };
  },

  async criarBloqueio(usuario, { dataInicio, dataFim, motivo, sobrescreverConflitos, SobrescreverConflitos, overwriteConflicts } = {}) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');
    const di = parseLocalIsoToUtcNaive(dataInicio, 'DataInicio');
    const df = parseLocalIsoToUtcNaive(dataFim, 'DataFim');
    const now = new Date();
    const motivoSanitizado = sanitizeMotivo(motivo);
    const shouldOverwrite = parseOverwriteConflictsFlag(
      sobrescreverConflitos ?? SobrescreverConflitos ?? overwriteConflicts
    );

    if (Number.isNaN(di.getTime()) || Number.isNaN(df.getTime())) {
      throw new HttpError(400, 'DataInicio/DataFim inválidas.');
    }
    if (!(di < df)) throw new HttpError(400, 'DataInicio deve ser menor que DataFim.');
    if (di < now) throw new HttpError(400, 'DataInicio não pode ser no passado.');

    try {
      const result = await queryWithContext(usuario, (req) => {
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
        req.input('DataInicio', sql.DateTime, di);
        req.input('DataFim', sql.DateTime, df);
        req.input('Motivo', sql.NVarChar(MOTIVO_MAX_LENGTH), motivoSanitizado);
        req.input('SobrescreverConflitos', sql.Bit, shouldOverwrite);
        bindConsultaStatusBloqueio(req);
      }, `
        BEGIN TRY
          BEGIN TRAN;

          DECLARE @Conflitos TABLE (Id INT PRIMARY KEY);
          DECLARE @NovoId INT = NULL;

          INSERT INTO @Conflitos (Id)
          SELECT Id
          FROM dbo.HorariosBloqueados WITH (UPDLOCK, HOLDLOCK)
          WHERE FisioterapeutaId = @FisioterapeutaId
            AND DataInicio < @DataFim
            AND DataFim > @DataInicio;

          IF EXISTS (SELECT 1 FROM @Conflitos)
             AND ISNULL(@SobrescreverConflitos, 0) = 0
          BEGIN
            RAISERROR(N'Conflito: já existe bloqueio sobreposto nesse período.', 16, 1);
          END

          IF EXISTS (
            SELECT 1
            FROM dbo.Consultas WITH (UPDLOCK, HOLDLOCK)
            WHERE FisioterapeutaId = @FisioterapeutaId
              ${CONSULTA_STATUS_BLOQUEIO_WHERE}
              AND DataHora >= @DataInicio
              AND DataHora <  @DataFim
          )
          BEGIN
            RAISERROR(N'Conflito: existe consulta marcada dentro desse período.', 16, 1);
          END

          IF EXISTS (SELECT 1 FROM @Conflitos)
             AND ISNULL(@SobrescreverConflitos, 0) = 1
          BEGIN
            DELETE FROM dbo.HorariosBloqueados
            WHERE Id IN (SELECT Id FROM @Conflitos);
          END

          -- Evita OUTPUT INSERTED.* para continuar compatível caso a tabela ganhe trigger no futuro.
          INSERT INTO dbo.HorariosBloqueados (FisioterapeutaId, DataInicio, DataFim, Motivo)
          VALUES (@FisioterapeutaId, @DataInicio, @DataFim, @Motivo);

          SET @NovoId = SCOPE_IDENTITY();

          SELECT TOP 1 *
          FROM dbo.HorariosBloqueados
          WHERE Id = @NovoId;

          COMMIT;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          THROW;
        END CATCH
      `);

      return result.recordset?.[0] ? mapBloqueioRow(result.recordset[0]) : null;
    } catch (err) {
      const message = getSqlErrorMessage(err);
      if (message.includes('Conflito: já existe bloqueio sobreposto nesse período.')) {
        throw new HttpError(409, 'Conflito: já existe bloqueio sobreposto nesse período.');
      }
      if (message.includes('Conflito: existe consulta marcada dentro desse período.')) {
        throw new HttpError(409, 'Conflito: existe consulta marcada dentro desse período.');
      }
      throw err;
    }
  },

  async atualizarBloqueio(usuario, bloqueioId, { dataInicio, dataFim, motivo }) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');
    const id = assertId(bloqueioId, 'bloqueioId');

    const atual = await queryWithContext(usuario, (req) => {
      req.input('Id', sql.Int, id);
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    }, `
      SELECT TOP 1 *
      FROM dbo.HorariosBloqueados
      WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;
    `);

    const row = atual.recordset?.[0];
    if (!row) throw new HttpError(404, 'Bloqueio não encontrado ou sem permissão.');

    const di = dataInicio === undefined ? row.DataInicio : parseLocalIsoToUtcNaive(dataInicio, 'DataInicio');
    const df = dataFim === undefined ? row.DataFim : parseLocalIsoToUtcNaive(dataFim, 'DataFim');
    const now = new Date();
    const motivoSanitizado = motivo === undefined ? (row.Motivo ?? null) : sanitizeMotivo(motivo);

    if (Number.isNaN(di.getTime()) || Number.isNaN(df.getTime())) {
      throw new HttpError(400, 'DataInicio/DataFim inválidas.');
    }
    if (!(di < df)) throw new HttpError(400, 'DataInicio deve ser menor que DataFim.');
    if (di < now) throw new HttpError(400, 'DataInicio não pode ser no passado.');

    try {
      const result = await queryWithContext(usuario, (req) => {
        req.input('Id', sql.Int, id);
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
        req.input('DataInicio', sql.DateTime, di);
        req.input('DataFim', sql.DateTime, df);
        req.input('Motivo', sql.NVarChar(MOTIVO_MAX_LENGTH), motivoSanitizado);
        bindConsultaStatusBloqueio(req);
      }, `
        BEGIN TRY
          BEGIN TRAN;

          IF NOT EXISTS (
            SELECT 1
            FROM dbo.HorariosBloqueados WITH (UPDLOCK, HOLDLOCK)
            WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId
          )
          BEGIN
            RAISERROR(N'Bloqueio não encontrado ou sem permissão.', 16, 1);
          END

          IF EXISTS (
            SELECT 1
            FROM dbo.HorariosBloqueados WITH (UPDLOCK, HOLDLOCK)
            WHERE FisioterapeutaId = @FisioterapeutaId
              AND Id <> @Id
              AND DataInicio < @DataFim
              AND DataFim > @DataInicio
          )
          BEGIN
            RAISERROR(N'Conflito: já existe bloqueio sobreposto nesse período.', 16, 1);
          END

          IF EXISTS (
            SELECT 1
            FROM dbo.Consultas WITH (UPDLOCK, HOLDLOCK)
            WHERE FisioterapeutaId = @FisioterapeutaId
              ${CONSULTA_STATUS_BLOQUEIO_WHERE}
              AND DataHora >= @DataInicio
              AND DataHora <  @DataFim
          )
          BEGIN
            RAISERROR(N'Conflito: existe consulta marcada dentro desse período.', 16, 1);
          END

          UPDATE dbo.HorariosBloqueados
          SET DataInicio = @DataInicio,
              DataFim = @DataFim,
              Motivo = @Motivo
          WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;

          SELECT TOP 1 *
          FROM dbo.HorariosBloqueados
          WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;

          COMMIT;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          THROW;
        END CATCH
      `);

      return result.recordset?.[0] ? mapBloqueioRow(result.recordset[0]) : null;
    } catch (err) {
      const message = getSqlErrorMessage(err);
      if (message.includes('Bloqueio não encontrado ou sem permissão.')) {
        throw new HttpError(404, 'Bloqueio não encontrado ou sem permissão.');
      }
      if (message.includes('Conflito: existe consulta marcada dentro desse período.')) {
        throw new HttpError(409, 'Conflito: existe consulta marcada dentro desse período.');
      }
      if (message.includes('Conflito: já existe bloqueio sobreposto nesse período.')) {
        throw new HttpError(409, 'Conflito: já existe bloqueio sobreposto nesse período.');
      }
      throw err;
    }
  },

  async excluirBloqueio(usuario, bloqueioId, { validarApenas } = {}) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');
    const id = assertId(bloqueioId, 'bloqueioId');
    const shouldValidateOnly = parseValidationOnlyFlag(validarApenas);

    if (shouldValidateOnly) {
      try {
        const atual = await queryWithContext(usuario, (req) => {
          req.input('Id', sql.Int, id);
          req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
          bindConsultaStatusBloqueio(req);
        }, `
          DECLARE @DataInicio DATETIME = NULL;
          DECLARE @DataFim DATETIME = NULL;

          SELECT TOP 1
            @DataInicio = DataInicio,
            @DataFim = DataFim
          FROM dbo.HorariosBloqueados
          WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;

          IF @DataInicio IS NULL OR @DataFim IS NULL
          BEGIN
            RAISERROR(N'Bloqueio não encontrado ou sem permissão.', 16, 1);
          END

          IF EXISTS (
            SELECT 1
            FROM dbo.Consultas
            WHERE FisioterapeutaId = @FisioterapeutaId
              ${CONSULTA_STATUS_BLOQUEIO_WHERE}
              AND DataHora >= @DataInicio
              AND DataHora <  @DataFim
          )
          BEGIN
            RAISERROR(N'Conflito: existe consulta marcada dentro desse período.', 16, 1);
          END

          SELECT TOP 1 *
          FROM dbo.HorariosBloqueados
          WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;
        `);

        const row = atual.recordset?.[0];
        if (!row) throw new HttpError(404, 'Bloqueio não encontrado ou sem permissão.');
        return { podeRemover: true, item: mapBloqueioRow(row) };
      } catch (err) {
        const message = getSqlErrorMessage(err);
        if (message.includes('Bloqueio não encontrado ou sem permissão.')) {
          throw new HttpError(404, 'Bloqueio não encontrado ou sem permissão.');
        }
        if (message.includes('Conflito: existe consulta marcada dentro desse período.')) {
          throw new HttpError(409, 'Conflito: existe consulta marcada dentro desse período.');
        }
        throw err;
      }
    }

    try {
      const result = await queryWithContext(usuario, (req) => {
        req.input('Id', sql.Int, id);
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
        bindConsultaStatusBloqueio(req);
      }, `
        BEGIN TRY
          BEGIN TRAN;

          DECLARE @DataInicio DATETIME = NULL;
          DECLARE @DataFim DATETIME = NULL;

          SELECT TOP 1
            @DataInicio = DataInicio,
            @DataFim = DataFim
          FROM dbo.HorariosBloqueados WITH (UPDLOCK, HOLDLOCK)
          WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;

          IF @DataInicio IS NULL OR @DataFim IS NULL
          BEGIN
            RAISERROR(N'Bloqueio não encontrado ou sem permissão.', 16, 1);
          END

          IF EXISTS (
            SELECT 1
            FROM dbo.Consultas WITH (UPDLOCK, HOLDLOCK)
            WHERE FisioterapeutaId = @FisioterapeutaId
              ${CONSULTA_STATUS_BLOQUEIO_WHERE}
              AND DataHora >= @DataInicio
              AND DataHora <  @DataFim
          )
          BEGIN
            RAISERROR(N'Conflito: existe consulta marcada dentro desse período.', 16, 1);
          END

          DELETE FROM dbo.HorariosBloqueados
          WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId;

          SELECT @@ROWCOUNT AS LinhasAfetadas;

          COMMIT;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK;
          THROW;
        END CATCH
      `);

      return (result.recordset?.[0]?.LinhasAfetadas || 0) > 0;
    } catch (err) {
      const message = getSqlErrorMessage(err);
      if (message.includes('Bloqueio não encontrado ou sem permissão.')) {
        throw new HttpError(404, 'Bloqueio não encontrado ou sem permissão.');
      }
      if (message.includes('Conflito: existe consulta marcada dentro desse período.')) {
        throw new HttpError(409, 'Conflito: existe consulta marcada dentro desse período.');
      }
      throw err;
    }
  },

  /* ----------------------- EXCEÇÕES DE DIA (CRUD) ------------------------ */

  async listarMinhasExcecoes(usuario, { de, ate } = {}) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');
    const deDate = parseOptionalDate(de, 'Parâmetro de');
    const ateDate = parseOptionalDate(ate, 'Parâmetro ate');

    if (deDate && ateDate && !(deDate < ateDate)) {
      throw new HttpError(400, 'Parâmetro de deve ser menor que ate.');
    }

    return listarExcecoesNoPeriodo(usuario, fisioterapeutaId, { deDate, ateDate });
  },

  async criarExcecao(usuario, payload = {}) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');
    const data = parseDateOnlyString(payload?.data ?? payload?.Data);
    const diaSemDisponibilidade = toBit(payload?.diaSemDisponibilidade ?? payload?.DiaSemDisponibilidade ?? 0);
    const notas = sanitizeNotas(payload?.notas ?? payload?.Notas ?? null);
    const intervalos = normalizeExcecaoIntervalosPayload(payload?.intervalos ?? payload?.Intervalos ?? []);

    if (diaSemDisponibilidade === 1 && intervalos.length) {
      throw new HttpError(400, 'Dia sem disponibilidade não pode ter intervalos.');
    }
    if (diaSemDisponibilidade === 0 && !intervalos.length) {
      throw new HttpError(400, 'A exceção precisa ter pelo menos um intervalo disponível.');
    }

    const existente = await obterExcecaoPorData(usuario, fisioterapeutaId, data);
    if (existente) {
      throw new HttpError(409, 'Já existe uma exceção cadastrada para esta data.');
    }

    await assertConsultasCompativeisComDisponibilidadeDia(
      usuario,
      fisioterapeutaId,
      data,
      diaSemDisponibilidade === 1 ? [] : intervalos
    );

    const result = await queryWithContext(usuario, (req) => {
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      req.input('Data', sql.Date, data);
      req.input('DiaSemDisponibilidade', sql.Bit, diaSemDisponibilidade);
      req.input('Notas', sql.NVarChar(NOTAS_MAX_LENGTH), notas);

      intervalos.forEach((intervalo, index) => {
        req.input(`HoraInicio${index}`, sql.Time, assertTimeStr(intervalo.horaInicio, 'HoraInicio'));
        req.input(`HoraFim${index}`, sql.Time, assertTimeStr(intervalo.horaFim, 'HoraFim'));
      });
    }, `
      BEGIN TRY
        BEGIN TRAN;

        DECLARE @ExcecaoId INT = NULL;

        INSERT INTO dbo.AgendasExcecoesDia (
          FisioterapeutaId,
          Data,
          DiaSemDisponibilidade,
          Notas,
          AtualizadoEm
        )
        VALUES (
          @FisioterapeutaId,
          @Data,
          @DiaSemDisponibilidade,
          @Notas,
          SYSDATETIME()
        );

        SET @ExcecaoId = SCOPE_IDENTITY();

${intervalos.map((_, index) => `
        INSERT INTO dbo.AgendasExcecoesDiaIntervalos (ExcecaoDiaId, HoraInicio, HoraFim)
        VALUES (@ExcecaoId, @HoraInicio${index}, @HoraFim${index});`).join('')}

        SELECT
          e.Id AS ExcecaoId,
          e.FisioterapeutaId,
          CONVERT(varchar(10), e.Data, 23) AS Data,
          e.DiaSemDisponibilidade,
          e.Notas,
          e.CriadoEm,
          e.AtualizadoEm,
          i.Id AS IntervaloId,
          i.HoraInicio,
          i.HoraFim
        FROM dbo.AgendasExcecoesDia e
        LEFT JOIN dbo.AgendasExcecoesDiaIntervalos i
          ON i.ExcecaoDiaId = e.Id
        WHERE e.Id = @ExcecaoId
        ORDER BY i.HoraInicio ASC, i.Id ASC;

        COMMIT;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH
    `, { requireContext: true });

    return groupExcecoesRows(result.recordset || [])[0] ?? null;
  },

  async atualizarExcecao(usuario, excecaoId, payload = {}) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');
    const id = assertId(excecaoId, 'ExcecaoId');
    const atual = await obterExcecaoPorId(usuario, fisioterapeutaId, id);
    if (!atual) throw new HttpError(404, 'Exceção não encontrada ou sem permissão.');

    const data = parseDateOnlyString(payload?.data ?? payload?.Data ?? atual.Data);
    const diaSemDisponibilidade = toBit(payload?.diaSemDisponibilidade ?? payload?.DiaSemDisponibilidade ?? atual.DiaSemDisponibilidade);
    const notas = payload?.notas !== undefined || payload?.Notas !== undefined
      ? sanitizeNotas(payload?.notas ?? payload?.Notas)
      : atual.Notas;
    const intervalos = payload?.intervalos !== undefined || payload?.Intervalos !== undefined
      ? normalizeExcecaoIntervalosPayload(payload?.intervalos ?? payload?.Intervalos ?? [])
      : atual.Intervalos.map((intervalo) => ({
          horaInicio: intervalo.HoraInicio,
          horaFim: intervalo.HoraFim,
        }));

    if (diaSemDisponibilidade === 1 && intervalos.length) {
      throw new HttpError(400, 'Dia sem disponibilidade não pode ter intervalos.');
    }
    if (diaSemDisponibilidade === 0 && !intervalos.length) {
      throw new HttpError(400, 'A exceção precisa ter pelo menos um intervalo disponível.');
    }

    const existenteMesmaData = await obterExcecaoPorData(usuario, fisioterapeutaId, data);
    if (existenteMesmaData && existenteMesmaData.Id !== id) {
      throw new HttpError(409, 'Já existe uma exceção cadastrada para esta data.');
    }

    await assertConsultasCompativeisComDisponibilidadeDia(
      usuario,
      fisioterapeutaId,
      data,
      diaSemDisponibilidade === 1 ? [] : intervalos
    );

    const result = await queryWithContext(usuario, (req) => {
      req.input('Id', sql.Int, id);
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      req.input('Data', sql.Date, data);
      req.input('DiaSemDisponibilidade', sql.Bit, diaSemDisponibilidade);
      req.input('Notas', sql.NVarChar(NOTAS_MAX_LENGTH), notas);

      intervalos.forEach((intervalo, index) => {
        req.input(`HoraInicio${index}`, sql.Time, assertTimeStr(intervalo.horaInicio, 'HoraInicio'));
        req.input(`HoraFim${index}`, sql.Time, assertTimeStr(intervalo.horaFim, 'HoraFim'));
      });
    }, `
      BEGIN TRY
        BEGIN TRAN;

        IF NOT EXISTS (
          SELECT 1
          FROM dbo.AgendasExcecoesDia WITH (UPDLOCK, HOLDLOCK)
          WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId
        )
        BEGIN
          RAISERROR(N'Exceção não encontrada ou sem permissão.', 16, 1);
        END

        UPDATE dbo.AgendasExcecoesDia
        SET Data = @Data,
            DiaSemDisponibilidade = @DiaSemDisponibilidade,
            Notas = @Notas,
            AtualizadoEm = SYSDATETIME()
        WHERE Id = @Id
          AND FisioterapeutaId = @FisioterapeutaId;

        DELETE FROM dbo.AgendasExcecoesDiaIntervalos
        WHERE ExcecaoDiaId = @Id;

${intervalos.map((_, index) => `
        INSERT INTO dbo.AgendasExcecoesDiaIntervalos (ExcecaoDiaId, HoraInicio, HoraFim)
        VALUES (@Id, @HoraInicio${index}, @HoraFim${index});`).join('')}

        SELECT
          e.Id AS ExcecaoId,
          e.FisioterapeutaId,
          CONVERT(varchar(10), e.Data, 23) AS Data,
          e.DiaSemDisponibilidade,
          e.Notas,
          e.CriadoEm,
          e.AtualizadoEm,
          i.Id AS IntervaloId,
          i.HoraInicio,
          i.HoraFim
        FROM dbo.AgendasExcecoesDia e
        LEFT JOIN dbo.AgendasExcecoesDiaIntervalos i
          ON i.ExcecaoDiaId = e.Id
        WHERE e.Id = @Id
        ORDER BY i.HoraInicio ASC, i.Id ASC;

        COMMIT;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH
    `, { requireContext: true });

    return groupExcecoesRows(result.recordset || [])[0] ?? null;
  },

  async excluirExcecao(usuario, excecaoId) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');
    const id = assertId(excecaoId, 'ExcecaoId');
    const atual = await obterExcecaoPorId(usuario, fisioterapeutaId, id);
    if (!atual) throw new HttpError(404, 'Exceção não encontrada ou sem permissão.');

    const suporte = await carregarSuporteDisponibilidadeDia(usuario, fisioterapeutaId, atual.Data);
    const rotinaIntervalos = suporte.rotinaRanges.map((range) => ({
      horaInicio: minutesToTimeStr(range.start),
      horaFim: minutesToTimeStr(range.end)
    }));
    await assertConsultasCompativeisComDisponibilidadeDia(usuario, fisioterapeutaId, atual.Data, rotinaIntervalos);

    const result = await queryWithContext(usuario, (req) => {
      req.input('Id', sql.Int, id);
      req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
    }, `
      BEGIN TRY
        BEGIN TRAN;

        IF NOT EXISTS (
          SELECT 1
          FROM dbo.AgendasExcecoesDia WITH (UPDLOCK, HOLDLOCK)
          WHERE Id = @Id AND FisioterapeutaId = @FisioterapeutaId
        )
        BEGIN
          RAISERROR(N'Exceção não encontrada ou sem permissão.', 16, 1);
        END

        DELETE FROM dbo.AgendasExcecoesDia
        WHERE Id = @Id
          AND FisioterapeutaId = @FisioterapeutaId;

        SELECT @@ROWCOUNT AS LinhasAfetadas;

        COMMIT;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH
    `, { requireContext: true });

    return (result.recordset?.[0]?.LinhasAfetadas || 0) > 0;
  },

  /* -------------------------- CALENDÁRIO DO FISIOTERAPEUTA ------------------- */

  async obterAgendaPublica(usuario, fisioterapeutaIdParam, { de, ate } = {}) {
    const fisioterapeutaId = assertId(fisioterapeutaIdParam, 'FisioterapeutaId');
    const deDate = parseOptionalDate(de, 'Parâmetro de') ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const ateDate = parseOptionalDate(ate, 'Parâmetro ate') ?? new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1);

    const [rotinaResult, excecoes] = await Promise.all([
      queryWithContext(usuario, (req) => {
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      }, `
        SELECT
          Id, DiaSemana, HoraInicio, HoraFim, Ativo, Notas
        FROM dbo.AgendasFisioterapeutas
        WHERE FisioterapeutaId = @FisioterapeutaId
          AND Ativo = 1
        ORDER BY DiaSemana ASC, HoraInicio ASC, Id ASC;
      `),
      listarExcecoesNoPeriodo(usuario, fisioterapeutaId, { deDate, ateDate }),
    ]);

    return {
      range: { de: deDate.toISOString(), ate: ateDate.toISOString() },
      rotina: (rotinaResult.recordset || []).map(mapAgendaRow),
      excecoes,
    };
  },

  async obterMeuCalendario(usuario, { de, ate }) {
    const fisioterapeutaId = assertId(usuario?.id, 'Usuário');

    const { deDate, ateDate } = assertRange(de, ate);

    // Se ainda não tiver rotina cadastrada, cria uma rotina padrão automaticamente
    await ensureRotinaPadraoSeVazia(usuario, fisioterapeutaId);

    const DURACAO_ESTIMADA_MIN = 60;

    const [rotinaResult, bloqueiosResult, consultasResult, excecoes] = await Promise.all([
      queryWithContext(usuario, (req) => {
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
      }, `
        SELECT
          Id, DiaSemana, HoraInicio, HoraFim, Ativo, Notas
        FROM dbo.AgendasFisioterapeutas
        WHERE FisioterapeutaId = @FisioterapeutaId
          AND Ativo = 1
        ORDER BY DiaSemana ASC, HoraInicio ASC, Id ASC;
      `),
      queryWithContext(usuario, (req) => {
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
        req.input('De', sql.DateTime, deDate);
        req.input('Ate', sql.DateTime, ateDate);
      }, `
        SELECT
          Id, DataInicio, DataFim, Motivo
        FROM dbo.HorariosBloqueados
        WHERE FisioterapeutaId = @FisioterapeutaId
          AND DataFim   >= @De
          AND DataInicio <  @Ate
        ORDER BY DataInicio ASC, Id ASC;
      `),
      queryWithContext(usuario, (req) => {
        req.input('FisioterapeutaId', sql.Int, fisioterapeutaId);
        req.input('De', sql.DateTime, deDate);
        req.input('Ate', sql.DateTime, ateDate);
      }, `
        SELECT
          c.Id,
          c.PacienteId,
          p.Nome AS PacienteNome,
          p.CPFValido AS PacienteCPFValido,
          p.EmailVerificado AS PacienteEmailVerificado,
          p.TelefoneVerificado AS PacienteTelefoneVerificado,
          CAST(CASE
            WHEN ISNULL(p.CPFValido, 0) = 1
             AND ISNULL(p.EmailVerificado, 0) = 1
             AND ISNULL(p.TelefoneVerificado, 0) = 1
              THEN 1 ELSE 0
          END AS bit) AS PacienteContaVerificada,
          c.DataHora,
          c.Status,
          c.ValorConsulta,
          ISNULL(c.PagamentoViaPlataforma, 1) AS PagamentoViaPlataforma
        FROM dbo.Consultas c
        LEFT JOIN dbo.Pacientes p
          ON p.Id = c.PacienteId
        WHERE c.FisioterapeutaId = @FisioterapeutaId
          AND c.DataHora >= @De
          AND c.DataHora <  @Ate
        ORDER BY c.DataHora ASC, c.Id ASC;
      `)
      ,
      listarExcecoesNoPeriodo(usuario, fisioterapeutaId, { deDate, ateDate }),
    ]);

    const rotina = (rotinaResult.recordset || []).map(mapAgendaRow);
    const bloqueios = (bloqueiosResult.recordset || []).map(mapBloqueioRow);

    const consultas = (consultasResult.recordset || []).map((c) => {
      const fim = new Date(c.DataHora);
      fim.setMinutes(fim.getMinutes() + DURACAO_ESTIMADA_MIN);

      return {
        ...c,
        DataHora: formatAppLocalDateTime(c.DataHora),
        DataFimEstimado: formatAppLocalDateTime(fim),
        DuracaoEstimadaMinutos: DURACAO_ESTIMADA_MIN
      };
    });

    return {
      range: { de: deDate.toISOString(), ate: ateDate.toISOString() },
      rotina,
      bloqueios,
      consultas,
      excecoes
    };
  }
};

export default agendaService;
