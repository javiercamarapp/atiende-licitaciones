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

export class UnauthorizedToolInputError extends AgentsError {
  constructor(readonly toolName: string, readonly field: string) {
    super(
      `La herramienta "${toolName}" no puede declarar "${field}" en su esquema de entrada: ` +
        "el tenant/organización lo inyecta siempre el runtime, nunca el modelo",
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
