import { createHash } from "node:crypto";

/** sha256 hex de una cadena UTF-8. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * `JSON.stringify` con claves ordenadas recursivamente para obtener un hash
 * estable sin importar el orden de propiedades en el objeto de origen
 * (necesario porque el mismo payload crudo puede deserializarse con distinto
 * orden de claves entre corridas).
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value instanceof Date) {
    // `Object.entries(new Date())` es `[]` (Date no tiene propiedades enumerables propias): sin este caso especial,
    // CUALQUIER Date colapsaría a `{}` y dos registros con fechas distintas producirían el mismo hash.
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortValue(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

/** sha256 hex de cualquier payload crudo serializable (para `rawHash` / snapshots inmutables). */
export function hashRawPayload(payload: unknown): string {
  return sha256Hex(stableStringify(payload));
}
