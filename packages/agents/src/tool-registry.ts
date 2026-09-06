import type { z } from "zod";
import { ACTION_KINDS, EFFECT_KINDS, type ActionKind, type EffectKind, type Role, type RiskLevel } from "./types.js";
import {
  ForbiddenRuntimeInputFieldError,
  InvalidDeclaredEffectsError,
  InvalidToolNameError,
  MissingActionKindError,
  RuntimeArgsTooDeepError,
  SchemaTooDeepError,
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
 *
 * AG-23 (MEDIA): estas 6 grafías son solo la base canónica. Ninguna
 * comparación en este módulo las usa por igualdad estricta directamente —
 * siempre pasan por `isForbiddenFieldKey()`, que normaliza la clave real
 * antes de comparar (ver esa función para la regla completa). Mantener esta
 * lista como las grafías "de referencia" documenta la intención, pero la
 * detección real cubre un espacio mucho mayor de variantes.
 */
const FORBIDDEN_INPUT_FIELDS = [
  "organizationId",
  "organization_id",
  "tenantId",
  "tenant_id",
  "orgId",
  "org_id",
];

/**
 * AG-23 (MEDIA): normaliza una clave de campo para comparación robusta,
 * replicando el patrón que `normalizeToolName()` (`authorization.ts`, AG-02)
 * ya aplica a nombres de herramienta: NFKC (unifica fullwidth/formas de
 * compatibilidad Unicode del MISMO carácter) + minúsculas + elimina TODOS
 * los caracteres no alfanuméricos (no solo `_ - .` espacio, cualquier
 * símbolo). Esto es deliberadamente más agresivo que `normalizeToolName`
 * porque aquí no hay restricción previa de "ASCII snake_case obligatorio"
 * (AG-02) sobre las claves de un objeto de datos — un `tool_call` puede
 * traer cualquier clave JSON válida.
 */
function normalizeFieldKey(key: string): string {
  return key.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Tokens canónicos ya normalizados, derivados de `FORBIDDEN_INPUT_FIELDS`. */
const NORMALIZED_FORBIDDEN_FIELD_TOKENS = new Set(FORBIDDEN_INPUT_FIELDS.map(normalizeFieldKey));

/**
 * AG-23: tokens cortos para los que también se comprueba coincidencia de
 * PREFIJO/SUFIJO (no solo igualdad exacta) tras normalizar. Deliberadamente
 * NO incluye `organizationid`: ya es lo bastante largo y específico como
 * para que un prefijo/sufijo suyo sea en la práctica el mismo campo con
 * ruido alrededor, mientras que `orgid`/`tenantid` sí aparecen camuflados
 * con prefijos/sufijos cortos (`x_org_id`, `org_id_override`, `tenantId2`).
 */
const FORBIDDEN_FIELD_AFFIX_TOKENS = ["orgid", "tenantid"] as const;

/**
 * AG-23 (MEDIA): sustituye toda comparación por igualdad estricta contra
 * `FORBIDDEN_INPUT_FIELDS` (`Array.includes`) — el hallazgo confirmado: una
 * clave con variación de mayúsculas (`ORG_ID`, `OrgId`), de separador
 * (`org-id`, `"org id"`), sin separador (`orgid`) o incluso fullwidth
 * Unicode (`ｏｒｇ＿ｉｄ`) no coincidía literalmente con ninguna de las 6
 * cadenas de la lista y evadía tanto el chequeo estático
 * (`findForbiddenFieldRecursive`) como el de runtime
 * (`findForbiddenKeyAtRuntime`, AG-22). Mismo patrón de bug que motivó AG-02
 * para nombres de herramienta.
 *
 * Regla (documentada también en README):
 * 1. Se normaliza la clave con `normalizeFieldKey()` (NFKC + minúsculas +
 *    solo alfanumérico).
 * 2. Coincidencia EXACTA contra los tokens canónicos normalizados
 *    (`organizationid`, `tenantid`, `orgid`) — cubre variantes de
 *    mayúsculas/separadores/Unicode del mismo nombre (`ORG_ID`, `org-id`,
 *    `Org.Id`, `"org id"`, `ｏｒｇ＿ｉｄ`, `orgId`).
 * 3. Coincidencia de PREFIJO o SUFIJO contra los tokens cortos `orgid` /
 *    `tenantid` (no `organizationid`, ver `FORBIDDEN_FIELD_AFFIX_TOKENS`) —
 *    cubre variantes con ruido alrededor como `x_org_id` (sufijo `orgid`) u
 *    `org_id_override` (prefijo `orgid`). Antes de comprobar el sufijo se
 *    ignora además un sufijo numérico final (`tenantId2` -> `tenantid`) para
 *    cubrir variantes versionadas del mismo campo.
 *    Deliberadamente NO es una búsqueda de subcadena en cualquier posición:
 *    eso produciría falsos positivos (p. ej. un hipotético campo que
 *    contuviera "orgid" en medio sin ser prefijo/sufijo). Nombres legítimos
 *    como `organizacion_nombre` (normaliza a "organizacionnombre", ni igual
 *    ni empieza/termina en un token), `origin_id` ("originid", no contiene
 *    "orgid" como prefijo/sufijo — "origin" y "org" no son la misma
 *    secuencia de letras) o `tenderId` ("tenderid", no relacionado con
 *    "tenantid") no coinciden con ninguna regla y NO se bloquean.
 *
 * Límite conocido (documentado en README): un campo legítimo cuyo nombre
 * normalizado empiece o termine en `orgid`/`tenantid` sin relación real con
 * el tenant del sistema (p. ej. un hipotético `partner_org_id` que
 * identificara una organización EXTERNA de un socio de negocio, no la del
 * tenant) también se rechazaría. Se acepta este falso positivo como
 * preferible al falso negativo que dejaba abierto AG-23: el campo puede
 * renombrarse sin ambigüedad (p. ej. `partnerExternalRef`).
 */
function isForbiddenFieldKey(key: string): boolean {
  const normalized = normalizeFieldKey(key);
  if (NORMALIZED_FORBIDDEN_FIELD_TOKENS.has(normalized)) return true;

  const withoutTrailingDigits = normalized.replace(/[0-9]+$/, "");
  if (withoutTrailingDigits !== normalized && NORMALIZED_FORBIDDEN_FIELD_TOKENS.has(withoutTrailingDigits)) {
    return true;
  }

  return FORBIDDEN_FIELD_AFFIX_TOKENS.some(
    (token) =>
      normalized.startsWith(token) || normalized.endsWith(token) || withoutTrailingDigits.endsWith(token),
  );
}

/**
 * AG-22 (MEDIA): profundidad máxima que `findForbiddenFieldRecursive`
 * atraviesa antes de rechazar el registro con `SchemaTooDeepError` en vez
 * de arriesgar un `RangeError` de pila no controlado. Un `inputSchema` lo
 * define el equipo desarrollador en código fuente, no un `tool_call` del
 * modelo ni un usuario final en runtime — el riesgo práctico de explotación
 * externa es bajo — pero un esquema patológico escrito por error (o
 * generado programáticamente) no debería tumbar el proceso con un error
 * críptico de V8.
 */
const MAX_SCHEMA_RECURSION_DEPTH = 256;

/**
 * AG-22 (MEDIA): profundidad máxima que `findForbiddenKeyAtRuntime`
 * atraviesa sobre los DATOS ya parseados de un `tool_call` antes de
 * rechazar con `RuntimeArgsTooDeepError`. Aquí sí hay una superficie de
 * ataque real (el modelo controla el JSON de los argumentos), así que el
 * límite es defensivo también contra un payload deliberadamente profundo.
 */
const MAX_RUNTIME_ARGS_DEPTH = 256;

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
  /**
   * Efectos que el `handler` declara honestamente que produce (AG-05,
   * límite conocido: ver README). Obligatorio y no vacío. `register()`
   * rechaza cualquier herramienta cuyo `riskLevel` sea `"read"` pero
   * declare un efecto fuera de `"read_only"` — una contradicción explícita
   * entre "esto solo lee" y "esto también firma/envía/paga".
   */
  declaredEffects: EffectKind[];
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
    this.assertValidDeclaredEffects(tool);
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
   * AG-05: `declaredEffects` es obligatorio, no vacío, y debe pertenecer al
   * enum cerrado `EFFECT_KINDS`. Además, un `riskLevel: "read"` no puede
   * declarar ningún efecto fuera de `"read_only"` — esa contradicción
   * explícita ("esto solo lee" + "esto también firma/envía") se rechaza en
   * el registro. Límite conocido: esto NO detecta un handler que mienta en
   * AMBOS campos a la vez (ver README, sección "Límite conocido (AG-05)").
   */
  private assertValidDeclaredEffects(tool: AnyToolDefinition): void {
    const effects = tool.declaredEffects;
    if (!Array.isArray(effects) || effects.length === 0) {
      throw new InvalidDeclaredEffectsError(tool.name, "declaredEffects es obligatorio y no puede estar vacío");
    }
    for (const effect of effects) {
      if (!(EFFECT_KINDS as readonly string[]).includes(effect)) {
        throw new InvalidDeclaredEffectsError(tool.name, `efecto desconocido "${effect}"`);
      }
    }
    if (tool.riskLevel === "read" && effects.some((effect) => effect !== "read_only")) {
      throw new InvalidDeclaredEffectsError(
        tool.name,
        `riskLevel "read" no puede declarar efectos fuera de "read_only" (declarados: ${effects.join(", ")})`,
      );
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
    const field = findForbiddenFieldRecursive(tool.inputSchema, tool.name);
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

  /**
   * Valida los argumentos de un tool_call contra su esquema. Rechaza si no
   * validan.
   *
   * AG-22 (MEDIA): además de la validación de esquema, revisa en TIEMPO DE
   * EJECUCIÓN las claves reales de los datos ya parseados (recursivo, con
   * guarda de profundidad) contra `FORBIDDEN_INPUT_FIELDS`. Esto complementa
   * `assertNoForbiddenFields` (que solo puede rechazar lo que un esquema
   * DECLARA estáticamente): un `z.record(z.string(), ...)`/`z.map(z.string(),
   * ...)` de clave genérica nunca declara `organizationId`, pero sí puede
   * ACEPTAR esa clave en los datos reales de un `tool_call` — límite
   * arquitectónico documentado en el README. Esta verificación cierra esa
   * vía en runtime, donde sí hay claves concretas que inspeccionar.
   */
  validateInput<Input = unknown>(name: string, args: unknown): Input {
    const tool = this.get(name);
    const result = tool.inputSchema.safeParse(args);
    if (!result.success) {
      throw new ToolValidationError(name, result.error.issues, "input");
    }
    const forbidden = findForbiddenKeyAtRuntime(result.data, name);
    if (forbidden) {
      throw new ForbiddenRuntimeInputFieldError(name, forbidden.field, forbidden.path);
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
 * AG-22 (MEDIA): revisa si un tipo de CLAVE estáticamente enumerable
 * (`ZodEnum`/`ZodNativeEnum`/`ZodLiteral`, o una `ZodUnion` de esos) declara
 * literalmente un valor prohibido — cierra el hueco de
 * `z.record(z.nativeEnum({...}), ...)`/`z.map(z.enum([...]), ...)` donde el
 * campo prohibido aparece como MIEMBRO del enum de clave, no como campo de
 * un `ZodObject`. Deliberadamente NO cubre `z.record(z.string(), ...)` de
 * clave genérica: ese caso no tiene nada estáticamente enumerable que
 * revisar (ver límite arquitectónico documentado en el README) — se
 * complementa con la verificación de runtime `findForbiddenKeyAtRuntime`.
 */
function checkKeyTypeForForbiddenField(keyType: z.ZodTypeAny): string | undefined {
  const def = (keyType as unknown as { _def?: Record<string, unknown> })._def;
  const typeName = def?.typeName as string | undefined;

  if (typeName === "ZodEnum") {
    const values = (def?.values as string[] | undefined) ?? [];
    return values.find((value) => isForbiddenFieldKey(value));
  }

  if (typeName === "ZodNativeEnum") {
    const values = Object.values((def?.values as Record<string, string | number> | undefined) ?? {}).map(String);
    return values.find((value) => isForbiddenFieldKey(value));
  }

  if (typeName === "ZodLiteral") {
    const value = def?.value;
    return typeof value === "string" && isForbiddenFieldKey(value) ? value : undefined;
  }

  if (typeName === "ZodUnion") {
    const options = (def?.options as z.ZodTypeAny[] | undefined) ?? [];
    for (const option of options) {
      const found = checkKeyTypeForForbiddenField(option);
      if (found) return found;
    }
  }

  return undefined;
}

/**
 * AG-11/AG-20/AG-22: busca RECURSIVAMENTE un campo prohibido en cualquier
 * `ZodObject` anidado, atravesando envolturas (`optional`/`nullable`/
 * `default`/`effects`/`catch`/`readonly`, vía `unwrapOneLayer`), arrays de
 * objetos, y los combinadores de Zod:
 * - `ZodUnion`/`ZodDiscriminatedUnion`: CUALQUIER rama (`_def.options`)
 *   puede declarar el campo prohibido, así que se revisan todas.
 * - `ZodIntersection`: ambos operandos (`_def.left`/`_def.right`).
 * - `ZodRecord`/`ZodMap`: el tipo de CLAVE (`_def.keyType`, AG-22 — si es
 *   estáticamente enumerable, vía `checkKeyTypeForForbiddenField`) y el
 *   tipo de VALOR (`_def.valueType`).
 * - `ZodTuple`: cada item posicional (`_def.items`) y el elemento variádico
 *   `rest`, si existe.
 * - `ZodLazy`: resuelve el esquema real vía `_def.getter()` — necesario
 *   para esquemas auto-referenciados/recursivos declarados con `z.lazy()`.
 * - `ZodPipeline` (AG-22, `.pipe()`): ambos lados (`_def.in`/`_def.out`) —
 *   ninguno de los dos coincide con `schema`/`innerType`, así que
 *   `unwrapOneLayer` no los alcanzaba.
 * - `ZodBranded` (AG-22, `.brand()`): el esquema envuelto (`_def.type`) —
 *   tampoco coincide con `schema`/`innerType`.
 *
 * AG-22 (guarda de profundidad): un esquema con miles de niveles de
 * anidamiento REAL (no cíclico — el `seen` por identidad de objeto solo
 * protege contra ciclos) agotaba el stack de V8 con un `RangeError` crudo.
 * Ahora se lanza `SchemaTooDeepError` explícito al superar
 * `MAX_SCHEMA_RECURSION_DEPTH`.
 *
 * Límite arquitectónico irreducible, documentado en el README: un
 * `z.record(z.string(), ...)`/`z.map(z.string(), ...)` de clave GENÉRICA
 * (no enumerable) siempre acepta `organizationId` como clave en runtime, y
 * ningún recorrido estático de la definición del esquema puede detectarlo
 * — no hay nada que "declare" el campo, solo datos que un llamador podría
 * enviar. Ver `findForbiddenKeyAtRuntime` para la mitigación en runtime.
 *
 * Retorna el primer nombre de campo prohibido encontrado, o `undefined` si
 * el esquema completo está limpio.
 */
function findForbiddenFieldRecursive(
  schema: z.ZodTypeAny,
  toolName: string,
  seen: Set<z.ZodTypeAny> = new Set(),
  depth = 0,
): string | undefined {
  if (depth > MAX_SCHEMA_RECURSION_DEPTH) {
    throw new SchemaTooDeepError(toolName, depth, MAX_SCHEMA_RECURSION_DEPTH);
  }
  if (seen.has(schema)) return undefined; // evita ciclos en esquemas recursivos (p. ej. z.lazy() auto-referenciado).
  seen.add(schema);

  const recurse = (next: z.ZodTypeAny): string | undefined =>
    findForbiddenFieldRecursive(next, toolName, seen, depth + 1);

  const shape = getZodObjectShape(schema);
  if (shape) {
    for (const [field, fieldSchema] of Object.entries(shape)) {
      if (isForbiddenFieldKey(field)) return field;
      const nested = recurse(fieldSchema as z.ZodTypeAny);
      if (nested) return nested;
    }
    return undefined;
  }

  const arrayElement = getZodArrayElement(schema);
  if (arrayElement) {
    return recurse(arrayElement);
  }

  const def = (schema as unknown as { _def?: Record<string, unknown> })._def;
  const typeName = def?.typeName as string | undefined;

  // ZodUnion/ZodDiscriminatedUnion — cualquier rama puede traer el campo prohibido.
  if (typeName === "ZodUnion" || typeName === "ZodDiscriminatedUnion") {
    const options = def?.options as z.ZodTypeAny[] | undefined;
    if (Array.isArray(options)) {
      for (const option of options) {
        const nested = recurse(option);
        if (nested) return nested;
      }
    }
    return undefined;
  }

  // ZodIntersection — ambos operandos pueden declararlo.
  if (typeName === "ZodIntersection") {
    for (const operand of [def?.left, def?.right] as Array<z.ZodTypeAny | undefined>) {
      if (operand) {
        const nested = recurse(operand);
        if (nested) return nested;
      }
    }
    return undefined;
  }

  // ZodRecord/ZodMap — AG-22: la clave (si es estáticamente enumerable) y el valor.
  if (typeName === "ZodRecord" || typeName === "ZodMap") {
    const keyType = def?.keyType as z.ZodTypeAny | undefined;
    if (keyType) {
      const forbiddenKey = checkKeyTypeForForbiddenField(keyType);
      if (forbiddenKey) return forbiddenKey;
    }
    const valueType = def?.valueType as z.ZodTypeAny | undefined;
    return valueType ? recurse(valueType) : undefined;
  }

  // ZodTuple — cualquier item posicional o el elemento variádico "rest".
  if (typeName === "ZodTuple") {
    const items = (def?.items as z.ZodTypeAny[] | undefined) ?? [];
    for (const item of items) {
      const nested = recurse(item);
      if (nested) return nested;
    }
    const rest = def?.rest as z.ZodTypeAny | undefined;
    return rest ? recurse(rest) : undefined;
  }

  // ZodLazy — resuelve el esquema real (esquemas auto-referenciados/recursivos).
  if (typeName === "ZodLazy") {
    const getter = def?.getter as (() => z.ZodTypeAny) | undefined;
    return typeof getter === "function" ? recurse(getter()) : undefined;
  }

  // AG-22: ZodPipeline (.pipe()) — ni `_def.in` ni `_def.out` coinciden con
  // `schema`/`innerType`, así que unwrapOneLayer no los alcanza.
  if (typeName === "ZodPipeline") {
    for (const side of [def?.in, def?.out] as Array<z.ZodTypeAny | undefined>) {
      if (side) {
        const nested = recurse(side);
        if (nested) return nested;
      }
    }
    return undefined;
  }

  // AG-22: ZodBranded (.brand()) — el esquema envuelto vive en `_def.type`.
  if (typeName === "ZodBranded") {
    const inner = def?.type as z.ZodTypeAny | undefined;
    return inner ? recurse(inner) : undefined;
  }

  const unwrapped = unwrapOneLayer(schema);
  if (unwrapped !== schema) {
    return recurse(unwrapped);
  }

  return undefined;
}

/**
 * AG-22 (MEDIA, verificación en tiempo de ejecución): recorre
 * recursivamente las claves REALES de un valor ya validado por zod (objetos
 * planos, arrays, y `Map`s — un `z.map()` valida a una instancia real de
 * `Map`) buscando un campo prohibido. A diferencia de
 * `findForbiddenFieldRecursive` (que inspecciona la DEFINICIÓN del
 * esquema), esto inspecciona los DATOS reales entregados por un
 * `tool_call` — la única forma de detectar `organizationId` colado a
 * través de un `z.record(z.string(), ...)`/`z.map(z.string(), ...)` de
 * clave genérica, que ningún recorrido estático puede ver (ver límite
 * arquitectónico documentado en el README).
 */
function findForbiddenKeyAtRuntime(
  value: unknown,
  toolName: string,
  path = "$",
  depth = 0,
): { field: string; path: string } | undefined {
  if (depth > MAX_RUNTIME_ARGS_DEPTH) {
    throw new RuntimeArgsTooDeepError(toolName, depth, MAX_RUNTIME_ARGS_DEPTH);
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenKeyAtRuntime(value[index], toolName, `${path}[${index}]`, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  if (value instanceof Map) {
    for (const [key, val] of value.entries()) {
      const keyStr = typeof key === "string" ? key : String(key);
      if (isForbiddenFieldKey(keyStr)) return { field: keyStr, path: `${path}.${keyStr}` };
      const found = findForbiddenKeyAtRuntime(val, toolName, `${path}.${keyStr}`, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  if (value instanceof Set) {
    let index = 0;
    for (const item of value.values()) {
      const found = findForbiddenKeyAtRuntime(item, toolName, `${path}<${index++}>`, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenFieldKey(key)) return { field: key, path: `${path}.${key}` };
      const found = findForbiddenKeyAtRuntime(val, toolName, `${path}.${key}`, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  return undefined;
}
