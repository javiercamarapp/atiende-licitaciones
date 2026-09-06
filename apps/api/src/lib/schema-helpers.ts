import { z } from 'zod';

/**
 * Campo de timestamp en una respuesta serializada con fastify-type-provider-zod.
 *
 * Bug real descubierto en esta ronda (no solo de test): las columnas
 * `timestamptz` de Postgres vuelven del driver (tanto `pg` como PGlite)
 * como instancias de `Date`, NUNCA como string ISO. El `serializerCompiler`
 * de fastify-type-provider-zod llama a `schema.safeParse(data)` antes de
 * serializar (ver node_modules/fastify-type-provider-zod/dist/src/core.js);
 * un campo declarado como `z.string()` rechaza un `Date` con
 * "Response doesn't match the schema" (500), incluso aunque el valor final
 * fuera a ser una fecha válida. Ninguna ruta de ronda 1 exponía un campo de
 * timestamp crudo en su respuesta, así que este bug no se manifestó hasta
 * las rutas de ronda 2 (company/tenders/matching) que sí lo hacen.
 *
 * `isoTimestamp` acepta string O Date y siempre transforma a ISO string,
 * aprovechando que `.transform()` sí se aplica en el `.safeParse()` que usa
 * el serializador (a diferencia de un simple `z.date()` que fallaría igual
 * al serializar un string, o un simple replacer de JSON.stringify, que
 * corre DESPUÉS de la validación y nunca se alcanzaría si el string()
 * estricto ya rechazó el Date).
 */
export const isoTimestamp = z.union([z.string(), z.date()]).transform((v) => (v instanceof Date ? v.toISOString() : v));

export const nullableIsoTimestamp = z
  .union([z.string(), z.date()])
  .nullable()
  .transform((v) => (v instanceof Date ? v.toISOString() : v));

/**
 * R5-07 (docs/auditoria-2/api-ronda5.md, BAJA): valida que "YYYY-MM-DD" sea
 * una fecha calendario REAL, no solo el patrón. `new Date('2026-02-30')`
 * NO lanza -- JS "corrige" desbordando al mes siguiente (2026-03-02) --
 * así que un simple regex de formato deja pasar fechas inexistentes hasta
 * la base de datos, donde Postgres las rechaza con un error de RUNTIME
 * ("date/time field value out of range"), un 500 en vez de un 422 de
 * validación de cliente. Aquí se reconstruye la fecha con componentes UTC
 * explícitos y se compara contra los valores de entrada -- si Postgres
 * "corrigió" algo, los componentes no coinciden.
 */
function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** "YYYY-MM-DD" que además debe ser una fecha calendario real (ver `isRealCalendarDate`) -- usar en vez de un simple `z.string().regex(...)` para cualquier campo de fecha que la aplicación vaya a interpretar/persistir como fecha real (no solo texto con forma de fecha). */
export const realCalendarDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'debe tener el formato "YYYY-MM-DD"')
  .refine(isRealCalendarDate, { message: 'debe ser una fecha calendario real (p. ej. "2026-02-30" no existe)' });
