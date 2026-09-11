/**
 * Normalización determinista para el fingerprint de entidad (REQ-111).
 * Reutiliza `normalizeText`/`stripAccents` de `@atiende/sources` (las
 * mismas usadas para deduplicar/matching de convocatorias) en vez de
 * reimplementar una variante distinta -- dos normalizaciones de texto
 * ligeramente distintas en el mismo repo serían una fuente de bugs sutiles.
 */
import { normalizeText } from "@atiende/sources";

/** RFC: mayúsculas, solo alfanumérico (+ Ñ, válida en RFC de persona física). Nunca valida longitud/checksum -- eso es responsabilidad de la capa de captura, no del fingerprint. */
export function normalizeRfc(rfc: string | null | undefined): string | null {
  if (!rfc) return null;
  const cleaned = rfc.toUpperCase().replace(/[^A-Z0-9Ñ]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

/** Nombre de persona física/moral: minúsculas, sin acentos/puntuación, espacios colapsados (mismo criterio que dedupe de convocatorias). */
export function normalizeEntityName(name: string | null | undefined): string | null {
  if (!name) return null;
  const norm = normalizeText(name);
  return norm.length > 0 ? norm : null;
}

export interface AddressParts {
  addressLine?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}

/**
 * Domicilio: concatena línea+ciudad+estado+CP y normaliza como texto. Una
 * coincidencia exacta de esta clave entre dos organizaciones es una señal
 * fuerte de interpósita persona (mismo domicilio fiscal/operativo
 * declarado por dos RFC distintos) -- pero SOLO si ambas declararon
 * domicilio suficientemente específico: un domicilio con menos de 2 partes
 * no verificables se descarta (`null`) para no producir falsos positivos
 * por coincidencias triviales (p.ej. dos empresas en la misma ciudad/estado
 * sin más detalle).
 */
export function normalizeAddress(parts: AddressParts | null | undefined): string | null {
  if (!parts) return null;
  const nonEmptyParts = [parts.addressLine, parts.city, parts.state, parts.postalCode].filter(
    (p): p is string => Boolean(p && p.trim() !== ""),
  );
  if (nonEmptyParts.length < 2) return null;
  const norm = normalizeText(nonEmptyParts.join(" "));
  return norm.length > 0 ? norm : null;
}
