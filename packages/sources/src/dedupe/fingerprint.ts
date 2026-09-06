import type { TenderRecord } from "../types/tender-record.js";
import { dateKey, normalizeText } from "../util/text.js";
import { sha256Hex } from "../util/hash.js";

/**
 * Patrón del "número de procedimiento" nacional mexicano (LAASSP), p.ej.
 * `LA-012NAY001-E15-2026` (licitación pública) o `IA-016B00003-N22-2026`
 * (invitación restringida): es el mismo identificador oficial sin importar
 * qué portal (ComprasMX/DOF/OCDS-SHCP/estatal) republique la convocatoria,
 * a diferencia de `externalId` (que sí es específico de cada fuente). Si
 * aparece en el título, es una señal MUCHO más fuerte que el texto genérico
 * del título para distinguir procedimientos (SR-07).
 */
const PROCEDURE_NUMBER_PATTERN = /\b[A-Z]{2,3}-\d{2,3}[A-Z0-9]{2,10}-[A-Za-z]\d{1,3}-\d{4}\b/;

function extractProcedureNumber(text: string): string {
  const match = text.toUpperCase().match(PROCEDURE_NUMBER_PATTERN);
  return match ? match[0] : "";
}

/**
 * Huella para cruzar la MISMA convocatoria publicada por dos fuentes
 * distintas (p.ej. ComprasMX y DOF), donde `source`+`externalId` difieren
 * pero se trata del mismo procedimiento real. Combina título normalizado +
 * entidad convocante normalizada + fecha de publicación (día) + fecha de
 * presentación/apertura (día, cuando existe) + número de procedimiento
 * embebido en el título (cuando existe, ver `PROCEDURE_NUMBER_PATTERN`).
 *
 * SR-07: sin las dos señales adicionales, dos procedimientos REALES y
 * DISTINTOS de la MISMA entidad, publicados el mismo día, con un título
 * administrativo genérico compartido ("Adquisición de material de
 * oficina"), colisionaban en la misma huella pese a tener `externalId`
 * distintos (confirmado con prueba adversarial). Ninguna de las dos señales
 * es infalible por sí sola (dos procedimientos distintos podrían, en
 * teoría, compartir también la misma fecha de presentación, o ninguno traer
 * el número de procedimiento en el título) — sigue siendo una heurística
 * probabilística, no una garantía de unicidad.
 *
 * IMPORTANTE (documentado explícitamente, ver `findByFingerprint`): un
 * resultado de esta función es SIEMPRE un "candidato a revisar" para fusión
 * entre fuentes, NUNCA una fusión automática — no sustituye la
 * deduplicación exacta por `(source, externalId)`.
 */
export function computeCrossSourceFingerprint(record: TenderRecord): string {
  const parts = [
    normalizeText(record.title),
    normalizeText(record.contractingEntity),
    dateKey(record.dates.published),
    dateKey(record.dates.submissionDeadline),
    extractProcedureNumber(record.title),
  ];
  return sha256Hex(parts.join("|"));
}
