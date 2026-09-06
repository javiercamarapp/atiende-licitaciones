import type { z } from "zod";
import { ACTION_KINDS, type ActionKind, type Role, type RiskLevel } from "./types.js";
import { MissingActionKindError, ToolNotFoundError, ToolValidationError, UnauthorizedToolInputError } from "./errors.js";
import type { SourcedValue } from "./no-fabrication.js";

/**
 * Campos que jamás puede declarar el esquema de entrada de una herramienta.
 * El tenant/organización lo inyecta siempre el runtime (ver
 * docs/investigacion/likida-arquitectura.md, patrón #4: "las tool
 * definitions del agente nunca exponen parámetros que decidan sobre el
 * tenant o el dinero"). Si un esquema los declara, `register()` rechaza el
 * registro completo.
 */
const FORBIDDEN_INPUT_FIELDS = [
  "organizationId",
  "organization_id",
  "tenantId",
  "tenant_id",
  "orgId",
  "org_id",
];

export interface ToolExecutionContext {
  /** Inyectado siempre por el runtime; el modelo nunca lo elige. */
  organizationId: string | null;
  actorId: string;
  actorRole: Role;
  runId: string;
  signal?: AbortSignal;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  riskLevel: RiskLevel;
  /**
   * Categoría semántica cerrada de lo que la herramienta REALMENTE hace
   * (AG-01/AG-05, REQ-165): `read`, `write`, `external_send`, `sign`,
   * `portal_action`, `contact_third_party` o `payment`. `AuthorizationPolicy`
   * deniega como prohibición dura cualquier `actionKind` de
   * `external_send`/`sign`/`portal_action`/`contact_third_party` sin
   * importar el nombre de la herramienta ni su `riskLevel` — así un alias o
   * sinónimo con nombre inocuo (p. ej. `enviar_paquete_final_al_comprador`)
   * no puede evadir la prohibición. Obligatorio: `register()` rechaza
   * cualquier herramienta sin un `actionKind` válido de este enum cerrado.
   */
  actionKind: ActionKind;
  /** Si la misma llamada (mismo idempotency key) puede repetirse sin efecto adicional. */
  idempotent: boolean;
  /** Si la herramienta opera sobre datos de una organización (recibe `organizationId` inyectado). */
  tenantScoped: boolean;
  /**
   * Política de autorización por rol específica de esta herramienta.
   * `true` = ese rol requiere autorización explícita (pending) incluso si el
   * riskLevel por sí solo permitiría auto. No puede usarse para *saltar*
   * autorización de riesgos irreversibles o acciones prohibidas: eso lo
   * decide siempre `AuthorizationPolicy`.
   */
  requiresAuthorization?: Partial<Record<Role, boolean>>;
  handler: (input: Input, ctx: ToolExecutionContext) => Promise<Output>;
  /**
   * Declara qué campos del resultado son "sensibles" (precio, certificación,
   * experiencia, referencia, firma, vigencia) para que `AgentRunner` los
   * evalúe con `NoFabricationPolicy` antes de dar el paso por completado
   * (docs/AMPLIACION-BACKOFFICE.md §6). Si se omite, la herramienta no
   * declara valores sensibles y no se aplica esta verificación adicional.
   */
  extractSensitiveValues?: (output: Output) => SourcedValue[];
}

export type AnyToolDefinition = ToolDefinition<any, any>;

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  register<Input, Output>(tool: ToolDefinition<Input, Output>): void {
    this.assertValidActionKind(tool);
    this.assertNoForbiddenFields(tool);
    this.tools.set(tool.name, tool as AnyToolDefinition);
  }

  /** AG-01: rechaza cualquier herramienta sin `actionKind` válido del enum cerrado (REQ-165). */
  private assertValidActionKind(tool: AnyToolDefinition): void {
    if (!(ACTION_KINDS as readonly string[]).includes(tool.actionKind as string)) {
      throw new MissingActionKindError(tool.name, tool.actionKind);
    }
  }

  private assertNoForbiddenFields(tool: AnyToolDefinition): void {
    const shape = getZodObjectShape(tool.inputSchema);
    if (!shape) return;
    for (const field of FORBIDDEN_INPUT_FIELDS) {
      if (field in shape) {
        throw new UnauthorizedToolInputError(tool.name, field);
      }
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): AnyToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolNotFoundError(name);
    return tool;
  }

  list(): AnyToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** Valida los argumentos de un tool_call contra su esquema. Rechaza si no validan. */
  validateInput<Input = unknown>(name: string, args: unknown): Input {
    const tool = this.get(name);
    const result = tool.inputSchema.safeParse(args);
    if (!result.success) {
      throw new ToolValidationError(name, result.error.issues, "input");
    }
    return result.data as Input;
  }

  validateOutput<Output = unknown>(name: string, output: unknown): Output {
    const tool = this.get(name);
    const result = tool.outputSchema.safeParse(output);
    if (!result.success) {
      throw new ToolValidationError(name, result.error.issues, "output");
    }
    return result.data as Output;
  }
}

/** Extrae `.shape` de un ZodObject si aplica; retorna undefined para otros tipos de esquema. */
function getZodObjectShape(schema: z.ZodTypeAny): Record<string, unknown> | undefined {
  const maybeShape = (schema as unknown as { shape?: unknown }).shape;
  if (maybeShape && typeof maybeShape === "object") {
    return maybeShape as Record<string, unknown>;
  }
  // ZodEffects/ZodOptional/etc envuelven el esquema real en `_def.schema` o `_def.innerType`.
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def;
  const inner = (def?.schema ?? def?.innerType) as z.ZodTypeAny | undefined;
  if (inner) return getZodObjectShape(inner);
  return undefined;
}
