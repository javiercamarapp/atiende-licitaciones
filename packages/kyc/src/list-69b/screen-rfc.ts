/**
 * Lógica de negocio PURA (sin BD) para evaluar un RFC contra un snapshot ya
 * descargado de la lista 69-B (REQ-026/REQ-112). Compartida por
 * `apps/api` (cruce "al alta", cuando se captura/actualiza el RFC del
 * perfil de empresa) y `apps/worker` (cruce nocturno recurrente) -- cada
 * app trae su propia capa de persistencia (mismo criterio que el resto del
 * repo: los paquetes de dominio no tocan BD), pero ambas deben clasificar
 * el mismo RFC exactamente igual.
 */
import { classifyNegativeListRisk } from "../types.js";
import { normalizeRfc } from "../fingerprint/normalize.js";
import type { KycVerdict, NegativeListEntry } from "../types.js";

export interface RfcScreeningResult {
  normalizedRfc: string;
  matched: boolean;
  entry?: NegativeListEntry;
  verdict: KycVerdict;
}

/**
 * `verdict` por nivel de riesgo (CFF Art. 69-B, ver `types.ts`):
 * - "definitivo": efectos generales de inexistencia de operaciones ->
 *   `suspended` (REQ-026: "RFC en lista 69-B definitivo → tenant
 *   suspendido", tolerancia cero).
 * - "presunto": fase aún desvirtuable -> `flagged` (requiere revisión, no
 *   suspensión automática -- el propio Art. 69-B reconoce que puede
 *   desvirtuarse).
 * - "desvirtuado"/"sentencia_favorable": el propio SAT confirma que el
 *   contribuyente YA SALIÓ de la situación de riesgo -> `clear`.
 * - "desconocido" (categoría no reconocida, ver `classifyNegativeListRisk`):
 *   nunca se asume "clear" ante una categoría nueva no contemplada ->
 *   `flagged` (conservador, para revisión humana).
 * - sin coincidencia en el listado -> `clear`.
 */
export function screenRfcAgainstEntries(
  rfcRaw: string,
  entriesByRfc: ReadonlyMap<string, NegativeListEntry>,
): RfcScreeningResult {
  const normalizedRfc = normalizeRfc(rfcRaw) ?? rfcRaw.trim().toUpperCase();
  const entry = entriesByRfc.get(normalizedRfc);
  if (!entry) {
    return { normalizedRfc, matched: false, verdict: "clear" };
  }
  const risk = classifyNegativeListRisk(entry.situacion);
  const verdict: KycVerdict =
    risk === "definitivo" ? "suspended" : risk === "presunto" || risk === "desconocido" ? "flagged" : "clear";
  return { normalizedRfc, matched: true, entry, verdict };
}

/** Construye el índice RFC normalizado -> entrada, para lookup O(1) contra un snapshot con miles de filas. */
export function indexEntriesByRfc(entries: readonly NegativeListEntry[]): Map<string, NegativeListEntry> {
  const map = new Map<string, NegativeListEntry>();
  for (const entry of entries) {
    const key = normalizeRfc(entry.rfc);
    if (key) map.set(key, entry);
  }
  return map;
}
