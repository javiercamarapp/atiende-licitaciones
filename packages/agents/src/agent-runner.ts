import { AuthorizationPolicy } from "./authorization.js";
import type { DependencyInvalidationRegistry } from "./dependency-invalidation.js";
import { InvalidAmountError, RunCancelledError, RunTimeoutError, RateLimitExceededError } from "./errors.js";
import type { AntiCorruptionGuardrail } from "./guardrails/anticorruption.js";
import { IdempotencyStore } from "./idempotency.js";
import type { BudgetLedger, BudgetReservation } from "./budget-ledger.js";
import { NoFabricationPolicy, scanForUnsourcedSensitiveData } from "./no-fabrication.js";
import type { TokenBucketRateLimiter } from "./rate-limiter.js";
import { RetryPolicy } from "./retry.js";
import type {
  AgentRun,
  RunStore,
  ToolCallStore,
  ToolCallStatus,
  ToolCallTrace,
} from "./stores.js";
import { estimateCostUsd, estimateTokens, hashValue } from "./tracing.js";
import type { ToolRegistry, ToolExecutionContext } from "./tool-registry.js";
import { isoNow, type ModelTier, type OrganizationId, type Role } from "./types.js";

export interface PlannedToolCall {
  toolName: string;
  input: unknown;
  /** Si se provee, la ejecución de este paso es idempotente por esta clave (REQ-073). */
  idempotencyKey?: string;
  /** Costo estimado en USD a reservar contra el presupuesto de la organización antes de ejecutar. */
  estimatedCostUsd?: number;
  /** Si no se da `estimatedCostUsd`, se puede derivar del tier de modelo usado por este paso. */
  tier?: ModelTier;
}

/**
 * Entidad de origen (p. ej. bases de una convocatoria, plazo legal) de la
 * que depende toda esta corrida. Si `DependencyInvalidationRegistry` marca
 * una versión más nueva de `key` antes de que el paso pendiente se ejecute,
 * la corrida se detiene como `invalidated` en vez de continuar sobre datos
 * obsoletos (docs/AMPLIACION-BACKOFFICE.md §3/§7).
 */
export interface RunDependency {
  key: string;
  version: string;
}

export interface AgentRunRequest {
  organizationId: OrganizationId;
  actorId: string;
  actorRole: Role;
  agentName: string;
  steps: PlannedToolCall[];
  signal?: AbortSignal;
  timeoutMsPerStep?: number;
  retryPolicy?: RetryPolicy;
  rateLimitTokensPerStep?: number;
  /** Enlaza esta corrida a un expediente/convocatoria para trazas correlacionadas de punta a punta. */
  correlationId?: string;
  /** Entidades de origen de las que depende esta corrida (ver `RunDependency`). */
  dependsOn?: RunDependency[];
}

export interface AgentRunnerDeps {
  registry: ToolRegistry;
  authorizationPolicy: AuthorizationPolicy;
  guardrail: AntiCorruptionGuardrail;
  runStore: RunStore;
  toolCallStore: ToolCallStore;
  idempotencyStore: IdempotencyStore;
  budgetLedger: BudgetLedger;
  rateLimiter: TokenBucketRateLimiter;
  defaultRetryPolicy?: RetryPolicy;
  /** Opcional: si se provee, cada paso valida que ninguna dependencia registrada haya sido invalidada. */
  dependencyRegistry?: DependencyInvalidationRegistry;
  /** Opcional: política de no-fabricación aplicada a herramientas que declaran `extractSensitiveValues`. */
  noFabricationPolicy?: NoFabricationPolicy;
}

interface PendingApproval {
  request: AgentRunRequest;
  nextIndex: number;
}

interface StepOutcome {
  stop: boolean;
  run: AgentRun;
}

const NO_RETRY = new RetryPolicy({ maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false });

/**
 * Ejecuta un `AgentRun` (plan de tool_calls) paso a paso, aplicando en cada
 * paso: invalidación por dependencia, guardrail anticorrupción, validación
 * de esquema, autorización (auto/pending/denied), idempotencia, rate
 * limiting, presupuesto, reintentos con backoff, timeout/cancelación y
 * verificación de no-fabricación de datos sensibles — y deja traza completa
 * (con `correlationId`) de cada paso en `ToolCallStore`.
 *
 * Un paso en `pending` detiene la corrida (`needs_approval`) hasta que se
 * llame `resume()`; una segunda llamada a `resume()` sobre la misma
 * aprobación nunca vuelve a ejecutar el paso (REQ-043). Una prohibición
 * dura (`AuthorizationPolicy`) siempre se deniega, incluso en `resume()`:
 * no existe ruta de bypass para ese tipo de acción.
 */
export class AgentRunner {
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly noFabricationPolicy: NoFabricationPolicy;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.noFabricationPolicy = deps.noFabricationPolicy ?? new NoFabricationPolicy();
  }

  async run(request: AgentRunRequest): Promise<AgentRun> {
    const run = await this.deps.runStore.createRun({
      organizationId: request.organizationId,
      agentName: request.agentName,
      actorId: request.actorId,
      actorRole: request.actorRole,
      totalSteps: request.steps.length,
      correlationId: request.correlationId ?? null,
    });

    if (request.dependsOn) {
      for (const dependency of request.dependsOn) {
        this.deps.dependencyRegistry?.registerDependency(run.id, dependency.key, dependency.version);
      }
    }

    const invalidation = this.deps.dependencyRegistry?.getInvalidation(run.id);
    if (invalidation) {
      return this.stopWith(run.id, "invalidated", `invalidado_por_cambio_de_origen:${invalidation.dependsOnKey}`).then(
        (o) => o.run,
      );
    }

    return this.executeFrom(run.id, request, 0);
  }

  /**
   * Reanuda una corrida en `needs_approval`. `decision: 'reject'` termina la
   * corrida como `denied` sin ejecutar el paso. `decision: 'approve'`
   * ejecuta el paso pendiente (una sola vez) y continúa con los siguientes,
   * salvo que una dependencia de origen haya sido invalidada mientras
   * esperaba aprobación, en cuyo caso la corrida termina como `invalidated`.
   */
  async resume(runId: string, decision: "approve" | "reject", approverId: string): Promise<AgentRun> {
    const pending = this.pendingApprovals.get(runId);
    if (!pending) {
      throw new Error(`La corrida "${runId}" no tiene una aprobación pendiente registrada`);
    }
    // Se consume de inmediato (sin `await` de por medio): una segunda llamada
    // concurrente a resume() para el mismo runId ya no encuentra la entrada.
    this.pendingApprovals.delete(runId);

    const run = await this.deps.runStore.getRun(runId);
    if (!run || run.status !== "needs_approval") {
      throw new Error(`La corrida "${runId}" no está esperando aprobación (estado actual: ${run?.status ?? "desconocido"})`);
    }

    if (decision === "reject") {
      return this.deps.runStore.updateRun(runId, {
        status: "denied",
        finishedAt: isoNow(),
        error: `rechazado_por:${approverId}`,
      });
    }

    const invalidation = this.deps.dependencyRegistry?.getInvalidation(runId);
    if (invalidation) {
      return this.deps.runStore.updateRun(runId, {
        status: "invalidated",
        finishedAt: isoNow(),
        error: `invalidado_por_cambio_de_origen:${invalidation.dependsOnKey}`,
      });
    }

    await this.deps.runStore.updateRun(runId, { status: "in_progress", pendingStepIndex: undefined });
    return this.executeFrom(runId, pending.request, pending.nextIndex, pending.nextIndex);
  }

  private async executeFrom(
    runId: string,
    request: AgentRunRequest,
    startIndex: number,
    approvedIndex?: number,
  ): Promise<AgentRun> {
    for (let index = startIndex; index < request.steps.length; index++) {
      const invalidation = this.deps.dependencyRegistry?.getInvalidation(runId);
      if (invalidation) {
        return this.stopWith(runId, "invalidated", `invalidado_por_cambio_de_origen:${invalidation.dependsOnKey}`).then(
          (o) => o.run,
        );
      }
      const step = request.steps[index];
      const outcome = await this.executeStep(runId, request, step, index, index === approvedIndex);
      if (outcome.stop) return outcome.run;
    }
    return this.deps.runStore.updateRun(runId, {
      status: "completed",
      finishedAt: isoNow(),
      completedSteps: request.steps.length,
    });
  }

  private async executeStep(
    runId: string,
    request: AgentRunRequest,
    step: PlannedToolCall,
    index: number,
    forceApproved: boolean,
  ): Promise<StepOutcome> {
    const startedAt = isoNow();
    const inputHash = hashValue(step.input);

    if (request.signal?.aborted) {
      return this.stopWith(runId, "cancelled", "cancelado_por_abort_signal");
    }

    const guardrailResult = this.deps.guardrail.check(JSON.stringify(step.input), {
      actorId: request.actorId,
      organizationId: request.organizationId,
      toolName: step.toolName,
    });
    if (guardrailResult.blocked) {
      await this.record(runId, index, step, request, {
        status: "blocked_guardrail",
        startedAt,
        inputHash,
        attempts: 0,
        error: `guardrail:${guardrailResult.matchedPatterns.join(",")}`,
      });
      return this.stopWith(runId, "blocked", `guardrail_blocked:${step.toolName}`);
    }

    let tool;
    try {
      tool = this.deps.registry.get(step.toolName);
      this.deps.registry.validateInput(step.toolName, step.input);
    } catch (error) {
      await this.record(runId, index, step, request, {
        status: "error",
        startedAt,
        inputHash,
        attempts: 0,
        error: describeError(error),
      });
      return this.stopWith(runId, "failed", describeError(error));
    }

    const requiresAuthorizationForRole = tool.requiresAuthorization?.[request.actorRole];
    const authorization = this.deps.authorizationPolicy.decide({
      toolName: step.toolName,
      riskLevel: tool.riskLevel,
      actorRole: request.actorRole,
      requiresAuthorizationForRole,
      // AG-01: siempre se pasa la categoría semántica declarada de la
      // herramienta, no solo su nombre, para que un alias con nombre
      // inocuo no pueda evadir una prohibición dura.
      actionKind: tool.actionKind,
    });

    // Una denegación NUNCA se puede saltar, incluso reanudando una
    // aprobación (`forceApproved`): las prohibiciones duras y el techo de
    // riesgo por rol no tienen ruta de bypass dentro del sistema.
    if (authorization.decision === "denied") {
      await this.record(runId, index, step, request, {
        status: "denied",
        startedAt,
        inputHash,
        attempts: 0,
        authorizationDecision: "denied",
        authorizationReason: authorization.reason,
      });
      return this.stopWith(runId, "denied", authorization.reason);
    }

    if (!forceApproved && authorization.decision === "pending") {
      await this.record(runId, index, step, request, {
        status: "pending_approval",
        startedAt,
        inputHash,
        attempts: 0,
        authorizationDecision: "pending",
        authorizationReason: authorization.reason,
      });
      this.pendingApprovals.set(runId, { request, nextIndex: index });
      const run = await this.deps.runStore.updateRun(runId, {
        status: "needs_approval",
        pendingStepIndex: index,
      });
      return { stop: true, run };
    }

    return this.executeAuthorized(runId, request, step, index, tool, startedAt, inputHash, authorization.decision);
  }

  private async executeAuthorized(
    runId: string,
    request: AgentRunRequest,
    step: PlannedToolCall,
    index: number,
    tool: ReturnType<ToolRegistry["get"]>,
    startedAt: string,
    inputHash: string,
    authorizationDecision: "auto" | "pending" | "denied",
  ): Promise<StepOutcome> {
    const tokens = estimateTokens(JSON.stringify(step.input ?? ""));
    const costUsd = step.estimatedCostUsd ?? (step.tier ? estimateCostUsd(step.tier, tokens) : 0);

    // AG-08: un `estimatedCostUsd` negativo/NaN/infinito nunca se reserva ni
    // se persiste tal cual en la traza — antes solo se evitaba la reserva
    // (`costUsd > 0` es `false` para negativos), pero el costo corrupto
    // igual quedaba escrito en `ToolCallTrace` y la corrida "completaba"
    // silenciosamente. Ahora el paso falla explícitamente, igual que
    // cualquier otro dato de entrada inválido.
    if (Number.isNaN(costUsd) || !Number.isFinite(costUsd) || costUsd < 0) {
      const error = new InvalidAmountError("AgentRunner.executeAuthorized.estimatedCostUsd", costUsd);
      await this.record(runId, index, step, request, {
        status: "error",
        startedAt,
        inputHash,
        attempts: 0,
        estimatedTokens: tokens,
        estimatedCostUsd: 0,
        authorizationDecision,
        error: describeError(error),
      });
      return this.stopWith(runId, "failed", describeError(error));
    }

    let reservation: BudgetReservation | undefined;
    if (costUsd > 0) {
      try {
        reservation = this.deps.budgetLedger.reserve(request.organizationId, costUsd);
      } catch (error) {
        await this.record(runId, index, step, request, {
          status: "error",
          startedAt,
          inputHash,
          attempts: 0,
          estimatedTokens: tokens,
          estimatedCostUsd: costUsd,
          authorizationDecision,
          error: describeError(error),
        });
        return this.stopWith(runId, "failed", describeError(error));
      }
    }

    let attempts = 0;
    const retryPolicy = request.retryPolicy ?? this.deps.defaultRetryPolicy ?? NO_RETRY;

    const attempt = async (): Promise<unknown> => {
      attempts++;
      if (!this.deps.rateLimiter.tryConsume(request.organizationId, request.rateLimitTokensPerStep ?? 1)) {
        throw new RateLimitExceededError(request.organizationId);
      }
      const ctx: ToolExecutionContext = {
        organizationId: request.organizationId,
        actorId: request.actorId,
        actorRole: request.actorRole,
        runId,
        signal: request.signal,
      };
      const invoke = () => tool.handler(step.input, ctx);
      const bounded = () => withTimeoutAndCancellation(invoke, { timeoutMs: request.timeoutMsPerStep, signal: request.signal, runId });
      if (step.idempotencyKey) {
        return this.deps.idempotencyStore.withIdempotency(request.organizationId, step.idempotencyKey, bounded);
      }
      return bounded();
    };

    let output: unknown;
    try {
      output = await retryPolicy.execute(attempt, request.signal, runId);
    } catch (error) {
      if (reservation) this.deps.budgetLedger.release(reservation.id);
      const status: ToolCallStatus = error instanceof RunCancelledError ? "cancelled" : "error";
      await this.record(runId, index, step, request, {
        status,
        startedAt,
        inputHash,
        attempts,
        estimatedTokens: tokens,
        estimatedCostUsd: costUsd,
        authorizationDecision,
        error: describeError(error),
      });
      const runStatus = error instanceof RunCancelledError ? "cancelled" : error instanceof RunTimeoutError ? "timed_out" : "failed";
      return this.stopWith(runId, runStatus, describeError(error));
    }

    try {
      this.deps.registry.validateOutput(step.toolName, output);
    } catch (error) {
      if (reservation) this.deps.budgetLedger.release(reservation.id);
      await this.record(runId, index, step, request, {
        status: "error",
        startedAt,
        inputHash,
        attempts,
        estimatedTokens: tokens,
        estimatedCostUsd: costUsd,
        authorizationDecision,
        error: describeError(error),
      });
      return this.stopWith(runId, "failed", describeError(error));
    }

    // No-fabricación (docs/AMPLIACION-BACKOFFICE.md §6, REQ-164): si la
    // herramienta declara valores sensibles (precio/certificación/
    // experiencia/referencia/firma/vigencia) vía `extractSensitiveValues`,
    // cada uno debe traer su fuente aprobada.
    let explicitlyHandledFields = new Set<string>();
    let missingFromExplicitCheck: string[] = [];
    if (tool.extractSensitiveValues) {
      const sensitiveValues = tool.extractSensitiveValues(output);
      explicitlyHandledFields = new Set(sensitiveValues.map((v) => v.fieldName));
      const evaluation = this.noFabricationPolicy.evaluate(sensitiveValues);
      if (evaluation.status === "pendiente_no_evaluable") {
        missingFromExplicitCheck = evaluation.missing;
      }
    }

    // AG-10 (REQ-164, tolerancia cero): además de lo anterior (opt-in), se
    // corre SIEMPRE un escaneo recursivo por defecto de todo el `output`
    // — ya no depende de que la herramienta declare `extractSensitiveValues`.
    // Esto cierra el hueco de un valor sensible bajo otro nombre de campo
    // (`costo` en vez de `precioUnitario`) o anidado en un array, que antes
    // simplemente nunca se evaluaba y la corrida terminaba `completed`. Los
    // campos que YA fueron declarados vía `extractSensitiveValues` (sourced
    // o no) se excluyen del escaneo por defecto: el chequeo explícito ya
    // los reportó con precisión, y no queremos duplicar el mismo hallazgo.
    const defaultScanFindings = scanForUnsourcedSensitiveData(output).filter(
      (finding) => !explicitlyHandledFields.has(finding.fieldName),
    );

    const allMissing = [...missingFromExplicitCheck, ...defaultScanFindings.map((f) => f.path)];

    if (allMissing.length > 0) {
      if (reservation) this.deps.budgetLedger.consume(reservation.id, costUsd);
      await this.record(runId, index, step, request, {
        status: "pending_no_fabrication",
        startedAt,
        inputHash,
        outputHash: hashValue(output),
        attempts,
        estimatedTokens: tokens,
        estimatedCostUsd: costUsd,
        authorizationDecision,
        missingSourcedFields: allMissing,
        error: `datos_sin_fuente_aprobada:${allMissing.join(",")}`,
      });
      return this.stopWith(runId, "needs_data", `datos_sin_fuente_aprobada:${allMissing.join(",")}`);
    }

    if (reservation) this.deps.budgetLedger.consume(reservation.id, costUsd);

    await this.record(runId, index, step, request, {
      status: "ok",
      startedAt,
      inputHash,
      outputHash: hashValue(output),
      attempts,
      estimatedTokens: tokens,
      estimatedCostUsd: costUsd,
      authorizationDecision,
    });

    const run = await this.deps.runStore.updateRun(runId, {
      completedSteps: index + 1,
    });
    return { stop: false, run };
  }

  private async record(
    runId: string,
    stepIndex: number,
    step: PlannedToolCall,
    request: AgentRunRequest,
    partial: Partial<ToolCallTrace> & { status: ToolCallStatus; startedAt: string; inputHash: string; attempts: number },
  ): Promise<ToolCallTrace> {
    const trace: ToolCallTrace = {
      id: `${runId}-step-${stepIndex}`,
      runId,
      stepIndex,
      toolName: step.toolName,
      organizationId: request.organizationId,
      actorId: request.actorId,
      actorRole: request.actorRole,
      finishedAt: isoNow(),
      estimatedTokens: 0,
      estimatedCostUsd: 0,
      correlationId: request.correlationId ?? null,
      ...partial,
    };
    return this.deps.toolCallStore.recordToolCall(trace);
  }

  private async stopWith(runId: string, status: AgentRun["status"], error: string): Promise<StepOutcome> {
    const run = await this.deps.runStore.updateRun(runId, { status, finishedAt: isoNow(), error });
    return { stop: true, run };
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function withTimeoutAndCancellation<T>(
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; signal?: AbortSignal; runId: string },
): Promise<T> {
  if (opts.signal?.aborted) throw new RunCancelledError(opts.runId);
  if (!opts.timeoutMs && !opts.signal) return fn();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new RunTimeoutError(opts.runId, opts.timeoutMs!));
        }, opts.timeoutMs)
      : undefined;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new RunCancelledError(opts.runId));
    };

    function cleanup() {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    opts.signal?.addEventListener("abort", onAbort, { once: true });

    fn().then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
