/**
 * Tipos compartidos de packages/agents.
 *
 * Este paquete es una librería TypeScript pura: no depende de ninguna base de
 * datos. Las interfaces de persistencia (`RunStore`, `ToolCallStore`, etc.)
 * se implementan aquí solo en memoria para pruebas; `apps/api` deberá
 * proveer implementaciones respaldadas por Postgres siguiendo el patrón de
 * `agente_corrida`/`tool_calls` documentado en
 * docs/investigacion/likida-arquitectura.md (organization_id nullable,
 * `unique(tool_name, run_id)` para idempotencia real en base).
 */

/** Roles de negocio definidos en REQ-062 de docs/REQUISITOS.md. */
export type Role =
  | "director"
  | "licitador"
  | "legal"
  | "finanzas"
  | "consultor_externo"
  | "representante_legal"
  | "system"
  | "superadmin";

/**
 * Nivel de riesgo de una herramienta. El orden importa: read < write <
 * external < irreversible. `irreversible` siempre requiere aprobación humana
 * (HITL), sin excepción, sin importar el rol (REQ-043/REQ-044/REQ-068).
 */
export type RiskLevel = "read" | "write" | "external" | "irreversible";

export const RISK_LEVEL_ORDER: Record<RiskLevel, number> = {
  read: 0,
  write: 1,
  external: 2,
  irreversible: 3,
};

/** Resultado de la política de autorización. */
export type AuthorizationDecision = "auto" | "pending" | "denied";

/** Los tres niveles de modelo por costo definidos en REQ-124. */
export type ModelTier = "economico" | "estandar" | "premium";

/** Identificador de organización (tenant). `null` = corrida de plataforma. */
export type OrganizationId = string | null;

export function isoNow(): string {
  return new Date().toISOString();
}
