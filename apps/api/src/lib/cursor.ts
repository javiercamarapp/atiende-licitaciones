/**
 * Cursor de paginación opaco `base64url([createdAtIso, id])`, mismo patrón
 * ya usado en `modules/tenders/routes.ts` (no se toca ese archivo para no
 * arriesgar su cobertura existente; ronda 4 añade este helper compartido
 * para las rutas nuevas que necesitan el mismo mecanismo: membresías y
 * bitácora de auditoría).
 */
export function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(JSON.stringify([sortKey, id])).toString('base64url');
}

export function decodeCursor(cursor: string): { sortKey: string; id: string } | null {
  try {
    const [sortKey, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof sortKey !== 'string' || typeof id !== 'string') return null;
    return { sortKey, id };
  } catch {
    return null;
  }
}

/** Interpreta el `limit` de querystring (string numérico, ver nota de `tenderListQuerySchema` sobre por qué no se usa `z.coerce.number()`). */
export function parsePageSize(limit: string | undefined, fallback = 20, max = 100): number {
  const parsed = limit ? Number.parseInt(limit, 10) : undefined;
  return parsed && parsed >= 1 && parsed <= max ? parsed : fallback;
}

/**
 * Normaliza una columna `timestamptz` del driver a ISO 8601 antes de
 * meterla en un cursor: tanto `pg` como PGlite devuelven esas columnas como
 * instancias de `Date` (ver `schema-helpers.ts`), y `Date.prototype.toString()`
 * (lo que produce un `String(date)` ingenuo) da un formato tipo
 * "Sun Sep 06 2026 03:06:56 GMT-0600 (Central Standard Time)" que Postgres
 * NO puede castear de vuelta a `timestamptz` (`time zone "gmt-0600" not
 * recognized`) -- bug real encontrado por la propia suite de esta ronda al
 * probar la segunda página de un cursor.
 */
export function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
