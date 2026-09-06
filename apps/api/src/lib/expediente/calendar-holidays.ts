/**
 * Carga del calendario OFICIAL de días inhábiles (`calendar_holidays`,
 * REQ-050/056, migración 0055) para un cómputo de plazo que empieza en
 * `startIsoDate`. Mismo comportamiento que la copia usada por
 * `post-award.routes.ts` (E11/ronda 5): con la tabla vacía (nada cargado
 * por un administrador todavía) regresa `[]` sin lanzar -- el motor de
 * plazos sigue funcionando con la aproximación documentada (solo
 * sábado/domingo), nunca inventa un feriado. Se duplica aquí (en vez de
 * importar desde `post-award.routes.ts`, que no la exporta) para no tocar
 * un archivo ya probado de una ronda anterior.
 */
import type { DbExecutor } from '@atiende/db';

/** Normaliza una columna `date` del driver (Date u "YYYY-MM-DD") a "YYYY-MM-DD" -- ver docstring extendido en `post-award.routes.ts`. */
function toDateOnlyString(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export async function loadOfficialHolidays(tx: DbExecutor, startIsoDate: string): Promise<string[]> {
  const year = Number(startIsoDate.slice(0, 4));
  if (!Number.isInteger(year)) return [];
  const { rows } = await tx.query<{ holiday_date: string | Date }>(
    `select holiday_date from calendar_holidays where jurisdiction = 'federal' and year in ($1, $2)`,
    [year, year + 1]
  );
  return rows.map((r) => toDateOnlyString(r.holiday_date) as string);
}
