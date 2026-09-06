import { createHash } from "node:crypto";

/**
 * Tipos compartidos de packages/expediente.
 *
 * Este paquete es una librería TypeScript pura: no depende de ninguna base
 * de datos ni de packages/db o packages/agents (evita acoplarse a APIs que
 * otros implementadores están cambiando en paralelo). Las interfaces de
 * persistencia (`CompanyDataResolver`, etc.) se implementan aquí solo en
 * memoria para pruebas; `apps/api` deberá proveer implementaciones
 * respaldadas por Postgres.
 *
 * Alcance: docs/AMPLIACION-BACKOFFICE.md §5-8, docs/REQUISITOS.md
 * secciones 4-8 y 32-33 (REQ-156..171), docs/ACEPTACION.md pruebas A6-A15.
 */

/** Zona horaria oficial del expediente (México central). */
export const MEXICO_CITY_TZ = "America/Mexico_City";

export function isoNow(): string {
  return new Date().toISOString();
}

/** Formatea un ISO a fecha/hora legible en la zona horaria de Ciudad de México. */
export function formatMexicoCityDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Fecha inválida: "${iso}"`);
  }
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: MEXICO_CITY_TZ,
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

/** `true` si `iso` (fecha límite) ya pasó respecto de `asOfIso` (por defecto ahora). */
export function isPast(iso: string, asOfIso: string = isoNow()): boolean {
  return new Date(iso).getTime() < new Date(asOfIso).getTime();
}

/** Roles usados por el flujo de aprobación del expediente (REQ-161/REQ-162). */
export type WorkflowRole = "owner" | "writer" | "reviewer" | "admin" | "viewer";

/**
 * Referencia trazable a un dato/documento aprobado o a una cláusula de las
 * bases. Toda afirmación de una propuesta debe traer una de estas — nunca
 * un valor "suelto" (REQ-027/REQ-035/REQ-164).
 */
export type SourceRef =
  | { kind: "company_data"; refId: string; capturedAt: string }
  | { kind: "clause"; documentId: string; page: number; clause?: string };

/** Calcula un sha256 hex determinista de cualquier valor serializable (para hashes de insumos, REQ-161). */
export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

/** JSON.stringify con claves ordenadas para que el mismo objeto lógico siempre produzca el mismo hash. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortKeysDeep(v);
    return out;
  }
  return value;
}
