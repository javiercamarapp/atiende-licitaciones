/**
 * Todas las fechas de negocio de este dominio (publicación, junta de
 * aclaraciones, presentación, fallo) son fechas/horas LEGALES mexicanas.
 * México abolió el horario de verano a nivel nacional en 2022 (Decreto DOF
 * 26-oct-2022): `America/Mexico_City` es UTC-6 fijo todo el año en la zona
 * horaria del Centro (donde operan ComprasMX/DOF/SHCP). Portales estatales
 * en Baja California (Pacífico, UTC-8/-7 con DST por frontera con EE.UU.) u
 * otras zonas deberían pasar su propio offset; este helper documenta el
 * caso por defecto y evita asumir silenciosamente la hora local del
 * proceso que ejecuta el conector.
 */
export const MEXICO_CITY_TZ = "America/Mexico_City";
export const MEXICO_CITY_FIXED_OFFSET = "-06:00";

/** Interpreta una fecha "naive" (sin zona) como hora del Centro de México y devuelve un `Date` UTC correcto. */
export function fromMexicoCityNaive(isoDateOrDateTime: string): Date {
  const hasTime = /T\d{2}:\d{2}/.test(isoDateOrDateTime);
  const withOffset = hasTime
    ? `${isoDateOrDateTime}${MEXICO_CITY_FIXED_OFFSET}`
    : `${isoDateOrDateTime}T00:00:00${MEXICO_CITY_FIXED_OFFSET}`;
  return new Date(withOffset);
}

/** Formatea un `Date` como ISO 8601 con el offset explícito de `America/Mexico_City` (para logs/eventos, nunca para comparar instantes). */
export function toMexicoCityIso(date: Date): string {
  const utcMs = date.getTime() + 6 * 60 * 60 * 1000; // UTC-6 fijo
  const shifted = new Date(utcMs);
  const iso = shifted.toISOString().replace("Z", "");
  return `${iso}${MEXICO_CITY_FIXED_OFFSET}`;
}
