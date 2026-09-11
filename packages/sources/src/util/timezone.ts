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

/** true si la cadena ya trae un designador de zona horaria explícito (`Z` o `±HH:MM`) al final. */
function hasExplicitOffset(isoDateOrDateTime: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(isoDateOrDateTime);
}

/**
 * Interpreta una fecha/hora "naive" (SIN zona horaria explícita) como hora
 * del Centro de México y devuelve un `Date` (instante UTC) correcto,
 * SIN importar el `TZ` del proceso que ejecuta este código (SR-02: antes de
 * este guard, una fecha que YA traía un offset explícito -p. ej. la que
 * usan los fixtures de ComprasMX con "Z"- se le concatenaba un SEGUNDO
 * offset por error si se llamaba dos veces, o dependía silenciosamente del
 * TZ del proceso si nunca se llamaba). Si `isoDateOrDateTime` YA trae un
 * offset explícito (`Z` o `±HH:MM`), se respeta tal cual (no se reinterpreta
 * como hora de México) y simplemente se parsea con `new Date()`.
 */
export function fromMexicoCityNaive(isoDateOrDateTime: string): Date {
  if (hasExplicitOffset(isoDateOrDateTime)) {
    return new Date(isoDateOrDateTime);
  }
  const hasTime = /T\d{2}:\d{2}/.test(isoDateOrDateTime);
  const withOffset = hasTime
    ? `${isoDateOrDateTime}${MEXICO_CITY_FIXED_OFFSET}`
    : `${isoDateOrDateTime}T00:00:00${MEXICO_CITY_FIXED_OFFSET}`;
  return new Date(withOffset);
}

/**
 * Suma (o resta, con `days` negativo) un número entero de días a un `Date`
 * real vía aritmética pura de milisegundos (TZ-invariante: nunca reinterpreta
 * el resultado como hora local del proceso, a diferencia de
 * `new Date(y, m, d + n)`). Vive aquí (fuera de `src/connectors/`) para que
 * un conector nunca necesite escribir su propio `new Date(<epoch + N>)`
 * literal — el escaneo estático de SR-12 (`test/tz-invariant.test.ts`)
 * prohíbe `new Date(` con argumento dentro de `src/connectors/` precisamente
 * para forzar que toda aritmética de fechas de negocio pase por un helper
 * centralizado y auditado como este, nunca por un cálculo ad-hoc repetido
 * en cada conector.
 */
export function addDaysUtc(date: Date, days: number): Date {
  const shifted = new Date();
  shifted.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
  return shifted;
}

/** Formatea un `Date` como ISO 8601 con el offset explícito de `America/Mexico_City` (para logs/eventos, nunca para comparar instantes). */
export function toMexicoCityIso(date: Date): string {
  const utcMs = date.getTime() + 6 * 60 * 60 * 1000; // UTC-6 fijo
  const shifted = new Date(utcMs);
  const iso = shifted.toISOString().replace("Z", "");
  return `${iso}${MEXICO_CITY_FIXED_OFFSET}`;
}
