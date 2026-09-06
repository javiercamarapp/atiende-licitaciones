import { createHash } from "node:crypto";
import { stripAccents } from "./text.js";

/** sha256 hex de una cadena UTF-8. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Normaliza una cadena para comparación/hashing de CONTENIDO (SR-01): forma
 * unicode canónica NFC (para que la misma letra acentuada representada como
 * carácter precompuesto o como base+diacrítico combinante produzca el mismo
 * texto) y espacios colapsados/recortados (para que espacios de más entre
 * palabras, tabs o saltos de línea incidentales no disparen una "versión"
 * falsa). NO es la normalización agresiva de `util/text.ts`
 * (`normalizeText`, que además baja a minúsculas y quita puntuación para
 * matching/fingerprint difuso): aquí se preserva mayúsculas/puntuación
 * porque el hash de versión debe seguir siendo sensible a cambios reales de
 * contenido.
 */
export function canonicalizeWhitespaceAndUnicode(input: string): string {
  return input.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Normaliza una CLAVE de anexo/clasificador para comparación de VERSIÓN
 * (SR-18): a diferencia de `canonicalizeWhitespaceAndUnicode` (deliberadamente
 * sensible a mayúsculas/acentos, usada para `title`/`contractingEntity` y el
 * resto del contenido, donde el casing SÍ puede ser semánticamente
 * significativo), esta función además pliega diacríticos y mayúsculas.
 *
 * Criterio de diseño explícito (documentado también en el README): un
 * cambio SOLO de mayúsculas o acentos en `attachments[].name` o
 * `classifiers[].code` (p.ej. volver a subir el mismo archivo con el nombre
 * en "ANEXO TÉCNICO" en vez de "Anexo Técnico") NO es un cambio de
 * CONTENIDO real de ese anexo/clasificador -- es formato incidental del
 * nombre del archivo/código, igual que el orden de un array (SR-01) o los
 * espacios/forma unicode ya cubiertos arriba. El contenido real de un anexo
 * vive en `url`/`sha256`, que SIGUEN comparándose tal cual (sensibles a
 * cualquier cambio, sin excepción): esta función nunca se aplica a esos
 * campos, solo a la CLAVE de nombre/código usada para ordenar y comparar el
 * conjunto.
 */
export function canonicalizeVersionKey(input: string): string {
  return stripAccents(canonicalizeWhitespaceAndUnicode(input).toLowerCase());
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
