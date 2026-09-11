/** Jerarquía de errores del paquete, con clasificación reintentable/no reintentable (REQ-077/REQ-078). */

export class AgentsError extends Error {
  constructor(message: string, readonly retryable: boolean = false) {
    super(message);
    this.name = new.target.name;
  }
}

export class ToolValidationError extends AgentsError {
  constructor(
    readonly toolName: string,
    readonly issues: unknown,
    kind: "input" | "output" = "input",
  ) {
    super(`Validación de esquema falló para la herramienta "${toolName}" (${kind})`, false);
  }
}

export class ToolNotFoundError extends AgentsError {
  constructor(readonly toolName: string) {
    super(`Herramienta no registrada: "${toolName}"`, false);
  }
}

export class MissingActionKindError extends AgentsError {
  constructor(readonly toolName: string, readonly actionKind: unknown) {
    super(
      `La herramienta "${toolName}" no declara un "actionKind" válido (recibido: ${JSON.stringify(actionKind)}); ` +
        "es obligatorio declarar la categoría semántica real de la acción (read/write/external_send/sign/" +
        "portal_action/contact_third_party/payment) para que AuthorizationPolicy pueda denegar prohibiciones " +
        "duras por categoría, no solo por nombre (REQ-165)",
      false,
    );
  }
}

export class InvalidToolNameError extends AgentsError {
  constructor(readonly toolName: string) {
    super(
      `Nombre de herramienta inválido: "${toolName}". Solo se permite ASCII snake_case ` +
        "([a-z0-9_]+): esto evita que un homoglifo Unicode (p. ej. una letra cirílica que " +
        "visualmente parece latina) o una variante de mayúsculas/separadores registre una " +
        "herramienta que evada por nombre las prohibiciones duras (AG-02, REQ-165)",
      false,
    );
  }
}

export class InvalidDeclaredEffectsError extends AgentsError {
  constructor(readonly toolName: string, readonly reason: string) {
    super(
      `La herramienta "${toolName}" declara efectos inválidos: ${reason} (AG-05: declaredEffects es ` +
        "obligatorio, debe pertenecer al enum cerrado, y un riskLevel 'read' no puede declarar ningún " +
        "efecto fuera de 'read_only')",
      false,
    );
  }
}

export class InvalidRoleCeilingError extends AgentsError {
  constructor(
    readonly role: string,
    readonly requestedCeiling: string,
    readonly defaultCeiling: string,
  ) {
    super(
      `No se puede fijar el techo de riesgo del rol "${role}" en "${requestedCeiling}": ` +
        `supera el default "${defaultCeiling}" (AG-17, REQ-062: "roleCeiling" solo puede BAJAR ` +
        "el techo de un rol respecto al default, nunca subirlo — en particular, el techo " +
        "\"read\" de consultor_externo es invariante)",
      false,
    );
  }
}

export class UnauthorizedToolInputError extends AgentsError {
  constructor(readonly toolName: string, readonly field: string) {
    super(
      `La herramienta "${toolName}" no puede declarar "${field}" en su esquema de entrada: ` +
        "el tenant/organización lo inyecta siempre el runtime, nunca el modelo",
      false,
    );
  }
}

/**
 * AG-22 (MEDIA): `findForbiddenFieldRecursive` recorre esquemas Zod sin
 * límite de profundidad explícito — un `ToolDefinition.inputSchema`
 * patológico (miles de niveles de anidamiento real, no cíclico) provocaba
 * antes un `RangeError` crudo del stack de V8 en vez de un error de
 * validación controlado. Se lanza esta excepción explícita al superar
 * `MAX_SCHEMA_RECURSION_DEPTH` niveles.
 */
export class SchemaTooDeepError extends AgentsError {
  constructor(
    readonly toolName: string,
    readonly depth: number,
    readonly maxDepth: number,
  ) {
    super(
      `El esquema de entrada de "${toolName}" supera la profundidad máxima permitida ` +
        `(${depth} > ${maxDepth} niveles) al buscar campos prohibidos (AG-22): se rechaza el ` +
        "registro en vez de arriesgar un RangeError de pila no controlado",
      false,
    );
  }
}

/**
 * AG-22 (MEDIA, verificación en tiempo de ejecución): complementa la
 * validación estática de `findForbiddenFieldRecursive` para el límite
 * arquitectónico irreducible de `z.record(z.string(), ...)`/`z.map(z.string(),
 * ...)` de clave genérica — un esquema así nunca "declara" organizationId
 * estáticamente, pero sí puede ACEPTAR esa clave en los datos reales de un
 * `tool_call`. `ToolRegistry.validateInput` rechaza en runtime cualquier
 * argumento ya validado por zod cuyas claves reales (recorridas
 * recursivamente) contengan un campo prohibido.
 */
export class ForbiddenRuntimeInputFieldError extends AgentsError {
  constructor(
    readonly toolName: string,
    readonly field: string,
    readonly path: string,
  ) {
    super(
      `Los argumentos de "${toolName}" contienen la clave prohibida "${field}" en ${path}: ` +
        "el tenant/organización lo inyecta siempre el runtime, nunca el modelo (AG-22, verificación " +
        "de runtime que complementa la del esquema estático para records/maps de clave genérica)",
      false,
    );
  }
}

/**
 * AG-22: guarda de profundidad para el recorrido recursivo en runtime de
 * `ToolRegistry.validateInput` (`findForbiddenKeyAtRuntime`), análoga a
 * `SchemaTooDeepError` pero sobre los DATOS ya parseados de un `tool_call`,
 * no sobre la definición del esquema.
 */
export class RuntimeArgsTooDeepError extends AgentsError {
  constructor(
    readonly toolName: string,
    readonly depth: number,
    readonly maxDepth: number,
  ) {
    super(
      `Los argumentos de "${toolName}" superan la profundidad máxima permitida ` +
        `(${depth} > ${maxDepth} niveles) al buscar claves prohibidas (AG-22): se rechaza en vez de ` +
        "arriesgar un RangeError de pila no controlado",
      false,
    );
  }
}

export class GuardrailBlockedError extends AgentsError {
  constructor(readonly matchedPatterns: string[]) {
    super(`Guardrail anticorrupción bloqueó la solicitud (${matchedPatterns.join(", ")})`, false);
  }
}

export class AuthorizationDeniedError extends AgentsError {
  constructor(readonly toolName: string, readonly reason: string) {
    super(`Autorización denegada para "${toolName}": ${reason}`, false);
  }
}

export class ApprovalPendingError extends AgentsError {
  constructor(readonly toolName: string, readonly reason: string) {
    super(`"${toolName}" requiere aprobación humana antes de ejecutarse: ${reason}`, false);
  }
}

export class IdempotencyInProgressError extends AgentsError {
  constructor(readonly key: string) {
    super(`Ya existe una ejecución en curso para la clave de idempotencia "${key}"`, true);
  }
}

export class InvalidAmountError extends AgentsError {
  constructor(readonly context: string, readonly amount: number) {
    super(
      `Monto inválido para "${context}": ${amount}. Se exige un número finito y no negativo ` +
        "(AG-08/AG-09: signo/NaN/Infinity nunca se aceptan silenciosamente, ni en presupuesto ni en rate limit)",
      false,
    );
  }
}

export class BudgetExceededError extends AgentsError {
  constructor(
    readonly organizationId: string | null,
    readonly requestedUsd: number,
    readonly availableUsd: number,
  ) {
    super(
      `Presupuesto excedido para org "${organizationId ?? "platform"}": solicitado ${requestedUsd} USD, disponible ${availableUsd} USD`,
      false,
    );
  }
}

export class RateLimitExceededError extends AgentsError {
  constructor(readonly organizationId: string | null) {
    super(`Rate limit excedido para org "${organizationId ?? "platform"}"`, true);
  }
}

export class RunCancelledError extends AgentsError {
  constructor(readonly runId: string) {
    super(`Corrida "${runId}" cancelada por AbortSignal`, false);
  }
}

export class RunTimeoutError extends AgentsError {
  constructor(readonly runId: string, readonly timeoutMs: number) {
    super(`Corrida "${runId}" excedió el timeout de ${timeoutMs}ms`, true);
  }
}

export class MissingCredentialsError extends AgentsError {
  constructor(message: string) {
    super(message, false);
  }
}

export class RetryableProviderError extends AgentsError {
  constructor(message: string, readonly status?: number) {
    super(message, true);
  }
}

export class NonRetryableProviderError extends AgentsError {
  constructor(message: string, readonly status?: number) {
    super(message, false);
  }
}

export class NoCompliantProviderError extends AgentsError {
  constructor(readonly component: string) {
    super(
      `Ningún proveedor cumple los requisitos de enrutamiento para el componente "${component}"`,
      false,
    );
  }
}

export class ModelGateFailedError extends AgentsError {
  constructor(readonly failedGates: string[]) {
    super(`Los siguientes gates de modelo alternativo fallaron: ${failedGates.join(", ")}`, false);
  }
}

/**
 * REQ-037: se lanza cuando se intenta crear un `approval_request` a partir
 * de un `AuditReport` cuyo `blocking[]` NO está vacío. `blocking=[]` es
 * condición NECESARIA (no la evalúa el juez LLM, la evalúan los 5 gates
 * deterministos de `packages/agents/src/audit/gates.ts` — ver
 * `assertApprovalRequestAllowed` en `audit/audit-report.ts`).
 */
export class AuditBlockedError extends AgentsError {
  constructor(readonly blockingCodes: string[]) {
    super(
      `No se puede crear approval_request: AuditReport.blocking no está vacío (${blockingCodes.join(", ")})`,
      false,
    );
  }
}

/**
 * Clasifica un error como reintentable o no. Reglas (REQ-077/REQ-078):
 * - HTTP 429 y 5xx: reintentable.
 * - HTTP 4xx (salvo 429): no reintentable.
 * - Errores de red (sin status, p. ej. fetch abortado o de conexión): reintentable
 *   salvo que sea una cancelación explícita (AbortError) o un error ya clasificado
 *   como no-reintentable.
 */
export function classifyError(error: unknown): "retryable" | "non_retryable" {
  if (error instanceof AgentsError) {
    return error.retryable ? "retryable" : "non_retryable";
  }
  if (error && typeof error === "object" && "name" in error && (error as { name: unknown }).name === "AbortError") {
    return "non_retryable";
  }
  const status = extractStatus(error);
  if (status !== undefined) {
    if (status === 429 || status >= 500) return "retryable";
    return "non_retryable";
  }
  // Error de red desconocido sin status HTTP: se asume transitorio.
  return "retryable";
}

function extractStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}
