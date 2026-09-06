import type { TenderRecord } from "../types/tender-record.js";
import { dateKey, normalizeText } from "../util/text.js";
import { sha256Hex } from "../util/hash.js";

/**
 * Huella para cruzar la MISMA convocatoria publicada por dos fuentes
 * distintas (p.ej. ComprasMX y DOF), donde `source`+`externalId` difieren
 * pero se trata del mismo procedimiento real. Combina título normalizado +
 * entidad convocante normalizada + fecha de publicación (día). No sustituye
 * la deduplicación exacta por `(source, externalId)`; es una señal adicional
 * para "candidatos de fusión" entre fuentes, expuesta vía
 * `TenderRepository.findByFingerprint`.
 */
export function computeCrossSourceFingerprint(record: TenderRecord): string {
  const parts = [
    normalizeText(record.title),
    normalizeText(record.contractingEntity),
    dateKey(record.dates.published),
  ];
  return sha256Hex(parts.join("|"));
}
