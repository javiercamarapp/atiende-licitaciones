/**
 * Utilidades de fecha compartidas por los adaptadores de `@atiende/expediente`
 * sobre `packages/db`. `@atiende/expediente` exige offset horario EXPLÍCITO
 * en toda fecha (`assertExplicitOffset`, ver packages/expediente/src/types.ts)
 * -- nunca acepta una fecha "naive". Las columnas `date` de Postgres (sin
 * hora, p.ej. `valid_until`) se anclan aquí a America/Mexico_City
 * (offset fijo `-06:00`; México no tiene horario de verano nacional desde
 * 2022) en el borde que corresponda: "end" para vigencias/plazos (vigente
 * HASTA el final de ese día), "start" para inicios de vigencia.
 */

const MEXICO_CITY_OFFSET = '-06:00';

/** Normaliza un valor de columna `timestamptz`/`date` del driver (Date o string) a "YYYY-MM-DD". */
function datePartOf(value: string | Date): string {
  const iso = value instanceof Date ? value.toISOString() : value;
  const match = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    throw new Error(`Valor de fecha no reconocible: ${JSON.stringify(value)}`);
  }
  return match[1];
}

export function dateOnlyToMexicoCityIso(value: string | Date | null, edge: 'start' | 'end'): string | null {
  if (value === null || value === undefined) return null;
  const datePart = datePartOf(value);
  return edge === 'end' ? `${datePart}T23:59:59${MEXICO_CITY_OFFSET}` : `${datePart}T00:00:00${MEXICO_CITY_OFFSET}`;
}

/** Convierte cualquier `timestamptz` (Date o string ISO) a un string ISO con offset explícito ("Z" si el driver ya lo trae, o tal cual si ya es string ISO con offset). */
export function timestampToIso(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** "Ahora" en ISO con offset explícito ("Z"), para usarse como `asOfIso` por defecto cuando no hay fecha límite de convocatoria conocida. */
export function nowIso(): string {
  return new Date().toISOString();
}
