/**
 * Utilidades de normalización de texto usadas para deduplicación y matching.
 * Deben ser deterministas y puras (sin dependencias externas) para que
 * huellas (fingerprints) calculadas hoy sean reproducibles mañana.
 */

/** Quita acentos/diacríticos conservando la letra base (á -> a, ñ -> n via NFD no aplica, se maneja aparte). */
export function stripAccents(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ñ/g, "n")
    .replace(/Ñ/g, "N");
}

/**
 * Normaliza texto para comparación difusa/dedupe: minúsculas, sin acentos,
 * sin puntuación, espacios colapsados y sin espacios al inicio/fin.
 */
export function normalizeText(input: string): string {
  return stripAccents(input.toLowerCase())
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Convierte una fecha (Date | string | undefined) a clave YYYY-MM-DD estable, o cadena vacía. */
export function dateKey(value: Date | string | undefined | null): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** true si `needle` normalizado aparece como palabra o subcadena en `haystack` normalizado. */
export function normalizedIncludes(haystack: string, needle: string): boolean {
  const h = normalizeText(haystack);
  const n = normalizeText(needle);
  if (!n) return false;
  return h.includes(n);
}
