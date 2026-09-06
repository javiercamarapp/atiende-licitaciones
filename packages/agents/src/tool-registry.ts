import type { z } from "zod";
import { ACTION_KINDS, type ActionKind, type Role, type RiskLevel } from "./types.js";
import {
  InvalidToolNameError,
  MissingActionKindError,
  ToolNotFoundError,
  ToolValidationError,
  UnauthorizedToolInputError,
} from "./errors.js";
import type { SourcedValue } from "./no-fabrication.js";

/**
 * Nombres de herramienta ASCII snake_case estrictos (AG-02): rechaza en
 * origen cualquier homoglifo Unicode (p. ej. una letra cirílica que
 * visualmente parece latina), mayúsculas o separador no-`_`. Esto cierra la
 * vía de evasión por nombre que la normalización NFKC de
 * `AuthorizationPolicy` no puede resolver por sí sola (NFKC no unifica
 * alfabetos distintos, solo formas de compatibilidad del MISMO carácter).
 */
const VALID_TOOL_NAME = /^[a-z0-9_]+$/;

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
    this.assertValidToolName(tool);
    this.assertValidActionKind(tool);
    this.assertNoForbiddenFields(tool);
    this.tools.set(tool.name, tool as AnyToolDefinition);
  }

  /** AG-02: rechaza cualquier nombre fuera de ASCII snake_case ([a-z0-9_]+). */
  private assertValidToolName(tool: AnyToolDefinition): void {
    if (!VALID_TOOL_NAME.test(tool.name)) {
      throw new InvalidToolNameError(tool.name);
    }
  }

  /** AG-01: rechaza cualquier herramienta sin `actionKind` válido del enum cerrado (REQ-165). */
  private assertValidActionKind(tool: AnyToolDefinition): void {
    if (!(ACTION_KINDS as readonly string[]).includes(tool.actionKind as string)) {
      throw new MissingActionKindError(tool.name, tool.actionKind);
    }
  }

  /**
   * AG-11: recorre RECURSIVAMENTE todas las `ZodObject` anidadas del
   * esquema (a través de objetos hijos y arrays de objetos), no solo el
   * nivel raíz. Antes, `organizationId` anidado en un objeto hijo (p. ej.
   * `z.object({ meta: z.object({ organizationId: z.string() }) })`) se
   * registraba sin lanzar, contradiciendo la garantía documentada en el
   * README.
   */
  private assertNoForbiddenFields(tool: AnyToolDefinition): void {
    const field = findForbiddenFieldRecursive(tool.inputSchema);
    if (field) {
      throw new UnauthorizedToolInputError(tool.name, field);
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
  return undefined;
}

/**
 * Quita una capa de envoltura no estructural (`ZodOptional`, `ZodNullable`,
 * `ZodDefault`, `ZodEffects`, etc.) para llegar al esquema real que
 * describe la forma de los datos. Retorna el mismo esquema si no hay nada
 * que desenvolver (evita recursión infinita).
 */
function unwrapOneLayer(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def;
  const inner = (def?.schema ?? def?.innerType) as z.ZodTypeAny | undefined;
  return inner ?? schema;
}

/** Extrae el tipo de elemento de un `ZodArray`, si aplica. */
function getZodArrayElement(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  const def = (schema as unknown as { _def?: Record<string, unknown> })._def;
  if (def?.typeName === "ZodArray") {
    return def.type as z.ZodTypeAny;
  }
  return undefined;
}

/**
 * AG-11: busca RECURSIVAMENTE (sin límite de profundidad) un campo
 * prohibido en cualquier `ZodObject` anidado, atravesando envolturas
 * (`optional`/`nullable`/`default`/`effects`) y arrays de objetos.
 * Retorna el primer nombre de campo prohibido encontrado, o `undefined` si
 * el esquema completo está limpio.
 */
function findForbiddenFieldRecursive(schema: z.ZodTypeAny, seen: Set<z.ZodTypeAny> = new Set()): string | undefined {
  if (seen.has(schema)) return undefined; // evita ciclos en esquemas recursivos.
  seen.add(schema);

  const shape = getZodObjectShape(schema);
  if (shape) {
    for (const [field, fieldSchema] of Object.entries(shape)) {
      if (FORBIDDEN_INPUT_FIELDS.includes(field)) return field;
      const nested = findForbiddenFieldRecursive(fieldSchema as z.ZodTypeAny, seen);
      if (nested) return nested;
    }
    return undefined;
  }

  const arrayElement = getZodArrayElement(schema);
  if (arrayElement) {
    return findForbiddenFieldRecursive(arrayElement, seen);
  }

  const unwrapped = unwrapOneLayer(schema);
  if (unwrapped !== schema) {
    return findForbiddenFieldRecursive(unwrapped, seen);
  }

  return undefined;
}
