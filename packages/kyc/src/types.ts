/**
 * Tipos del dominio KYC negativo (REQ-026/REQ-112) y fingerprint de entidad
 * (REQ-111). Ver README.md de este paquete para el detalle de verificación
 * en vivo y las decisiones de diseño.
 */

/** Identificador de una lista oficial negativa/de sancionados. Extensible: hoy solo `sat_69b` tiene conector real. */
export type NegativeListId = "sat_69b";

/**
 * Una fila del listado de la lista 69-B del SAT (Art. 69-B del Código
 * Fiscal de la Federación — EFOS/EDOS). Campos = subconjunto real de las
 * columnas del CSV público (ver README): se conserva el texto LITERAL de
 * `situacion` tal como lo publica el SAT, nunca normalizado a un enum
 * cerrado (el SAT podría agregar una categoría nueva sin aviso).
 */
export interface NegativeListEntry {
  rfc: string;
  nombreContribuyente: string;
  situacion: string;
}

/**
 * Clasificación de riesgo de una `situacion` cruda del SAT, en la capa de
 * aplicación (nunca en el esquema de BD, ver migración 0099). Fundamento:
 * CFF Art. 69-B (verificado 2026-09-10/11 contra
 * https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf, última reforma DOF
 * 09-04-2026, ver docs/legal/verificacion-legal.md) — "Definitivo" es la
 * publicación con efectos generales de inexistencia de operaciones
 * (párrafo cuarto/quinto del artículo); "Presunto" es la fase de
 * presunción aún desvirtuable (quince días + prórroga); "Desvirtuado" y
 * "Sentencia Favorable" son los dos listados que el propio Art. 69-B
 * obliga a publicar trimestralmente para quienes SALIERON de la situación
 * de riesgo.
 */
export type NegativeListRiskLevel = "definitivo" | "presunto" | "desvirtuado" | "sentencia_favorable" | "desconocido";

const SITUACION_RISK_MAP: Record<string, NegativeListRiskLevel> = {
  definitivo: "definitivo",
  presunto: "presunto",
  desvirtuado: "desvirtuado",
  "sentencia favorable": "sentencia_favorable",
};

/** Clasifica el texto crudo de `situacion` (case-insensitive, sin acentos) a un nivel de riesgo conocido. */
export function classifyNegativeListRisk(situacionRaw: string): NegativeListRiskLevel {
  const key = situacionRaw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
  return SITUACION_RISK_MAP[key] ?? "desconocido";
}

/**
 * Snapshot completo de una corrida de ingesta de una lista negativa.
 * `listAsOfDate`/`listAsOfRaw` capturan la leyenda "Información actualizada
 * al ..." que el propio CSV del SAT publica en su primera línea — cuando no
 * se puede parsear, `listAsOfDate` es `null` con el motivo en
 * `listAsOfParseError` (nunca se infiere silenciosamente).
 */
export interface NegativeListSnapshot {
  listId: NegativeListId;
  sourceUrl: string;
  fetchedAt: Date;
  listAsOfDate: string | null;
  listAsOfRaw: string | null;
  listAsOfParseError?: string;
  entries: NegativeListEntry[];
  rawHash: string;
}

/** Igual que `LiveVerification` de `@atiende/sources` (mismo contrato, dominio distinto): nunca `verified: true` sin evidencia real. */
export interface LiveVerification {
  verified: boolean;
  note: string;
}

export interface NegativeListFetchContext {
  now?: () => Date;
}

/**
 * Puerto real de un conector de lista negativa (mismo patrón que
 * `SourceConnector` de `@atiende/sources`): una implementación REAL contra
 * el servicio público, y un doble FAKE explícito para pruebas (ver
 * `connectors/fake-connector.ts`) — nunca se mockea la lógica de negocio de
 * este paquete (clasificación de riesgo, fingerprint), solo el borde
 * externo (la descarga HTTP).
 */
export interface NegativeListConnector {
  readonly listId: NegativeListId;
  readonly liveVerification: LiveVerification;
  fetchSnapshot(ctx?: NegativeListFetchContext): Promise<NegativeListSnapshot>;
}

/** Lanzado cuando un conector no puede operar por falta de configuración explícita (mismo criterio que `SourceNotConfiguredError`). */
export class NegativeListNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NegativeListNotConfiguredError";
  }
}

/**
 * Veredicto de KYC negativo vigente para un tenant (mismo nombre que el
 * `enum kyc_verdict` de la migración 0099 -- deben mantenerse en
 * sincronía manualmente, no hay generación automática de tipos desde el
 * esquema en este repo). `null`/ausente en BD significa "nunca verificado"
 * -- un estado explícito distinto de `clear`, nunca confundido con él (ver
 * `app.tenant_kyc_verdict` en la migración).
 */
export type KycVerdict = "clear" | "flagged" | "suspended";

/**
 * Umbral de obsolescencia de la lista 69-B (REQ-026 literal: "alerta si
 * listas >48h desactualizadas"). Medido desde el último `fetchedAt` de una
 * corrida EXITOSA (mismo criterio operativo que `STALE_THRESHOLD_SECONDS`
 * de `apps/api/src/modules/admin/routes.ts` para conectores de fuentes,
 * generalizado a 48h aquí por ser el valor que pide el requisito) -- nunca
 * desde `listAsOfDate` (la fecha de corte que el propio SAT declara), que
 * reflejaría la cadencia de publicación del SAT, no un problema de ESTE
 * pipeline.
 */
export const NEGATIVE_LIST_STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

/** `true` si nunca hubo una corrida exitosa (`lastFetchedAt === null`, nunca tratado como "reciente") o si la última corrida exitosa fue hace más del umbral. */
export function isNegativeListStale(lastFetchedAt: Date | null, now: () => Date = () => new Date()): boolean {
  if (!lastFetchedAt) return true;
  return now().getTime() - lastFetchedAt.getTime() > NEGATIVE_LIST_STALE_THRESHOLD_MS;
}
