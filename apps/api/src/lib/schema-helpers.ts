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
