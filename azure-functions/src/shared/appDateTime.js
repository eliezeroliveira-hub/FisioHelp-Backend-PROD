const DEFAULT_APP_TIME_ZONE = 'America/Sao_Paulo';

function readPart(parts, type) {
  const raw = parts.find((item) => item.type === type)?.value;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function getAppTimeZoneParts(date = new Date(), timeZone = DEFAULT_APP_TIME_ZONE) {
  const source = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(source.getTime())) {
    throw new Error('Data invalida para conversao de fuso horario.');
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(source);
  const hour = readPart(parts, 'hour');

  return {
    year: readPart(parts, 'year'),
    month: readPart(parts, 'month'),
    day: readPart(parts, 'day'),
    hour: hour === 24 ? 0 : hour,
    minute: readPart(parts, 'minute'),
    second: readPart(parts, 'second'),
    millisecond: source.getMilliseconds(),
  };
}

function dateFromAppTimeZoneParts(parts) {
  if (!parts) throw new Error('Partes de data/hora ausentes.');

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour ?? 0);
  const minute = Number(parts.minute ?? 0);
  const second = Number(parts.second ?? 0);
  const millisecond = Number(parts.millisecond ?? 0);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second) ||
    !Number.isFinite(millisecond)
  ) {
    throw new Error('Partes de data/hora invalidas.');
  }

  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
}

export function agoraBrasilDate(date = new Date()) {
  return dateFromAppTimeZoneParts(getAppTimeZoneParts(date, DEFAULT_APP_TIME_ZONE));
}
