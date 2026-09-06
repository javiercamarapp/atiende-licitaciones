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

/**
 * Categoría semántica cerrada de lo que una herramienta REALMENTE hace,
 * declarada explícitamente por su autor en `ToolDefinition.actionKind`
 * (AG-01/AG-05, REQ-165). A diferencia del nombre libre de la herramienta
 * (que puede tener alias/sinónimos no listados, p. ej.
 * `enviar_paquete_final_al_comprador`), `actionKind` es un enum cerrado que
 * `AuthorizationPolicy` usa para denegar prohibiciones duras por
 * CATEGORÍA, sin importar cómo se llame la tool. `ToolRegistry.register()`
 * rechaza cualquier herramienta sin un `actionKind` válido de esta lista.
 */
export const ACTION_KINDS = [
  "read",
  "write",
  "external_send",
  "sign",
  "portal_action",
  "contact_third_party",
  "payment",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * AG-05: efectos que un `ToolDefinition.handler` declara honestamente que
 * produce, más allá de su `actionKind`/`riskLevel` declarado. Es una
 * verificación de CONSISTENCIA, no una sandbox real: un handler "envoltorio"
 * que MIENTE tanto en `riskLevel` como en `declaredEffects` (declara
 * `read`/`["read_only"]` pero internamente firma/envía) no puede detectarse
 * por este medio — ver la sección "Límite conocido (AG-05)" del README.
 * Lo que SÍ garantiza `ToolRegistry.register()`: un handler cuyo
 * `riskLevel` es `"read"` NO PUEDE declarar ningún efecto fuera de
 * `read_only` (si lo hace, es una contradicción explícita que se rechaza
 * en el registro, en vez de pasar desapercibida).
 */
export const EFFECT_KINDS = [
  "read_only",
  "internal_write",
  "external_send",
  "sign",
  "portal_action",
  "contact_third_party",
  "payment",
] as const;

export type EffectKind = (typeof EFFECT_KINDS)[number];

/** Los tres niveles de modelo por costo definidos en REQ-124. */
export type ModelTier = "economico" | "estandar" | "premium";

/** Identificador de organización (tenant). `null` = corrida de plataforma. */
export type OrganizationId = string | null;

export function isoNow(): string {
  return new Date().toISOString();
}
