const HORA_ROTINA_RE = /^(\d{2}):(\d{2})$/;

export const ROTINA_PADRAO_AUTO = Object.freeze({
  diasSemana: Object.freeze([1, 2, 3, 4, 5]),
  horaInicio: '08:00',
  horaFim: '18:00',
  ativo: 1,
  notas: null,
});

export function rotinaPadraoHoraSql(value) {
  const match = HORA_ROTINA_RE.exec(String(value || '').trim());
  if (!match) throw new Error('Horário da rotina padrão inválido.');

  const hora = Number(match[1]);
  const minuto = Number(match[2]);
  if (hora < 0 || hora > 23 || minuto < 0 || minuto > 59) {
    throw new Error('Horário da rotina padrão inválido.');
  }

  return new Date(Date.UTC(1970, 0, 1, hora, minuto, 0, 0));
}
