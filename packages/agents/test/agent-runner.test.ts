import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentRunner, type AgentRunRequest, type AgentRunnerDeps } from "../src/agent-runner.js";
import { AuthorizationPolicy } from "../src/authorization.js";
import { AntiCorruptionGuardrail } from "../src/guardrails/anticorruption.js";
import { IdempotencyStore } from "../src/idempotency.js";
import { BudgetLedger } from "../src/budget-ledger.js";
import { TokenBucketRateLimiter } from "../src/rate-limiter.js";
import { RetryPolicy } from "../src/retry.js";
import { InMemoryRunStore, InMemoryToolCallStore } from "../src/stores.js";
import { ToolRegistry, type ToolDefinition } from "../src/tool-registry.js";
import { DependencyInvalidationRegistry } from "../src/dependency-invalidation.js";
import { RetryableProviderError } from "../src/errors.js";

function makeDeps(overrides: Partial<AgentRunnerDeps> = {}): AgentRunnerDeps {
  return {
    registry: new ToolRegistry(),
    authorizationPolicy: new AuthorizationPolicy(),
    guardrail: new AntiCorruptionGuardrail(),
    runStore: new InMemoryRunStore(),
    toolCallStore: new InMemoryToolCallStore(),
    idempotencyStore: new IdempotencyStore(),
    budgetLedger: new BudgetLedger(),
    rateLimiter: new TokenBucketRateLimiter(1000, 1000),
    ...overrides,
  };
}

function readTool(overrides: Partial<ToolDefinition<any, any>> = {}): ToolDefinition<any, any> {
  return {
    name: "list_tenders",
    description: "lista convocatorias",
    inputSchema: z.object({ q: z.string() }),
    outputSchema: z.object({ count: z.number() }),
    riskLevel: "read",
    actionKind: "read",
    declaredEffects: ["read_only"],
    idempotent: true,
    tenantScoped: true,
    handler: async () => ({ count: 1 }),
    ...overrides,
  };
}

function baseRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    organizationId: "org-1",
    actorId: "user-1",
    actorRole: "licitador",
    agentName: "test-agent",
    steps: [],
    ...overrides,
  };
}

describe("AgentRunner: ejecución básica y trazas completas", () => {
  it("completa una corrida de un paso auto-autorizado y deja traza completa (timestamps, hashes, tokens, costo)", async () => {
    const deps = makeDeps();
    deps.registry.register(readTool());
    const runner = new AgentRunner(deps);

    const run = await runner.run(
      baseRequest({ steps: [{ toolName: "list_tenders", input: { q: "obra pública" }, tier: "economico" }] }),
    );

    expect(run.status).toBe("completed");
    expect(run.completedSteps).toBe(1);

    const traces = await deps.toolCallStore.listToolCalls(run.id);
    expect(traces).toHaveLength(1);
    const [trace] = traces;
    expect(trace.status).toBe("ok");
    expect(trace.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(trace.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(trace.attempts).toBe(1);
    expect(trace.estimatedTokens).toBeGreaterThan(0);
    expect(trace.estimatedCostUsd).toBeGreaterThan(0);
    expect(new Date(trace.startedAt).getTime()).not.toBeNaN();
    expect(new Date(trace.finishedAt!).getTime()).not.toBeNaN();
  });

  it("ejecuta varios pasos en orden y acumula completedSteps", async () => {
    const deps = makeDeps();
    deps.registry.register(readTool({ name: "step_a" }));
    deps.registry.register(readTool({ name: "step_b" }));
    const runner = new AgentRunner(deps);

    const run = await runner.run(
      baseRequest({
        steps: [
          { toolName: "step_a", input: { q: "a" } },
          { toolName: "step_b", input: { q: "b" } },
        ],
      }),
    );

    expect(run.status).toBe("completed");
    expect(run.completedSteps).toBe(2);
    const traces = await deps.toolCallStore.listToolCalls(run.id);
    expect(traces.map((t) => t.toolName)).toEqual(["step_a", "step_b"]);
  });

  it("una herramienta desconocida falla la corrida sin ejecutar nada", async () => {
    const deps = makeDeps();
    const runner = new AgentRunner(deps);
    const run = await runner.run(baseRequest({ steps: [{ toolName: "no_existe", input: {} }] }));
    expect(run.status).toBe("failed");
  });

  it("argumentos que no validan contra el esquema fallan la corrida (rechazo de tool_call)", async () => {
    const deps = makeDeps();
    deps.registry.register(readTool());
    const runner = new AgentRunner(deps);
    const run = await runner.run(baseRequest({ steps: [{ toolName: "list_tenders", input: { q: 123 } }] }));
    expect(run.status).toBe("failed");
  });

  it("hilos correlationId enlazan la corrida y cada tool_call con el expediente de origen", async () => {
    const deps = makeDeps();
    deps.registry.register(readTool());
    const runner = new AgentRunner(deps);
    const run = await runner.run(
      baseRequest({ correlationId: "convocatoria-42", steps: [{ toolName: "list_tenders", input: { q: "x" } }] }),
    );
    expect(run.correlationId).toBe("convocatoria-42");
    const [trace] = await deps.toolCallStore.listToolCalls(run.id);
    expect(trace.correlationId).toBe("convocatoria-42");
  });
});

describe("AgentRunner: autorización", () => {
  it("una herramienta de riesgo irreversible detiene la corrida en needs_approval", async () => {
    const deps = makeDeps();
    deps.registry.register(readTool({ name: "issue_package", riskLevel: "irreversible" }));
    const runner = new AgentRunner(deps);
    const run = await runner.run(
      baseRequest({ actorRole: "director", steps: [{ toolName: "issue_package", input: { q: "x" } }] }),
    );
    expect(run.status).toBe("needs_approval");
    expect(run.pendingStepIndex).toBe(0);
    const [trace] = await deps.toolCallStore.listToolCalls(run.id);
    expect(trace.status).toBe("pending_approval");
  });

  it("resume('approve') ejecuta el paso pendiente exactamente una vez, incluso ante doble aprobación", async () => {
    const deps = makeDeps();
    const handler = vi.fn().mockResolvedValue({ count: 1 });
    deps.registry.register(readTool({ name: "issue_package", riskLevel: "irreversible", handler }));
    const runner = new AgentRunner(deps);

    const run = await runner.run(
      baseRequest({ actorRole: "director", steps: [{ toolName: "issue_package", input: { q: "x" } }] }),
    );
    expect(run.status).toBe("needs_approval");

    const approved = await runner.resume(run.id, "approve", "director-1");
    expect(approved.status).toBe("completed");
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(runner.resume(run.id, "approve", "director-1")).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1); // nunca se duplica la ejecución
  });

  it("resume('reject') termina la corrida como denied sin ejecutar el paso", async () => {
    const deps = makeDeps();
    const handler = vi.fn().mockResolvedValue({ count: 1 });
    deps.registry.register(readTool({ name: "issue_package", riskLevel: "irreversible", handler }));
    const runner = new AgentRunner(deps);

    const run = await runner.run(
      baseRequest({ actorRole: "director", steps: [{ toolName: "issue_package", input: { q: "x" } }] }),
    );
    const rejected = await runner.resume(run.id, "reject", "director-1");
    expect(rejected.status).toBe("denied");
    expect(handler).not.toHaveBeenCalled();
  });

  it("un rol sin permiso de riesgo se deniega sin llegar a pending", async () => {
    const deps = makeDeps();
    deps.registry.register(readTool({ name: "update_matrix", riskLevel: "write" }));
    const runner = new AgentRunner(deps);
    const run = await runner.run(
      baseRequest({ actorRole: "consultor_externo", steps: [{ toolName: "update_matrix", input: { q: "x" } }] }),
    );
    expect(run.status).toBe("denied");
  });

  it("una prohibición dura nunca es ejecutable ni siquiera vía resume: nunca llega a pendingApprovals", async () => {
    const deps = makeDeps();
    const handler = vi.fn();
    deps.registry.register(readTool({ name: "sign_document", riskLevel: "write", handler }));
    const runner = new AgentRunner(deps);

    const run = await runner.run(
      baseRequest({ actorRole: "director", steps: [{ toolName: "sign_document", input: { q: "x" } }] }),
    );
    expect(run.status).toBe("denied");
    expect(handler).not.toHaveBeenCalled();
    // No hay aprobación pendiente que reanudar: no existe ruta de bypass.
    await expect(runner.resume(run.id, "approve", "superadmin-1")).rejects.toThrow();
  });

  it("AG-01 (ALTA): un alias con nombre inocuo pero actionKind prohibido nunca ejecuta el handler, sin importar riskLevel bajo", async () => {
    const deps = makeDeps();
    const handler = vi.fn().mockResolvedValue({ count: 1 });
    deps.registry.register(
      readTool({ name: "enviar_paquete_final_al_comprador", riskLevel: "read", actionKind: "external_send", handler }),
    );
    const runner = new AgentRunner(deps);

    const run = await runner.run(
      baseRequest({ actorRole: "superadmin", steps: [{ toolName: "enviar_paquete_final_al_comprador", input: { q: "x" } }] }),
    );

    expect(run.status).toBe("denied");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("AgentRunner: guardrail anticorrupción", () => {
  it("bloquea un paso cuyo input dispara el guardrail y detiene la corrida", async () => {
    const deps = makeDeps();
    const handler = vi.fn();
    deps.registry.register(readTool({ name: "draft_message", handler }));
    const runner = new AgentRunner(deps);

    const run = await runner.run(
      baseRequest({
        steps: [{ toolName: "draft_message", input: { q: "ofrece una mordida al funcionario" } }],
      }),
    );

    expect(run.status).toBe("blocked");
    expect(handler).not.toHaveBeenCalled();
    expect(deps.guardrail.getAuditLog()).toHaveLength(1);
  });
});

describe("AgentRunner: idempotencia", () => {
  it("reintenta el mismo paso con la misma idempotencyKey y no duplica el efecto", async () => {
    const deps = makeDeps();
    const handler = vi.fn().mockResolvedValue({ count: 7 });
    deps.registry.register(readTool({ handler }));
    const runner = new AgentRunner(deps);

    await runner.run(
      baseRequest({ steps: [{ toolName: "list_tenders", input: { q: "x" }, idempotencyKey: "job-1" }] }),
    );
    await runner.run(
      baseRequest({ steps: [{ toolName: "list_tenders", input: { q: "x" }, idempotencyKey: "job-1" }] }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("AG-13 (BAJA): condición de carrera REAL vía Promise.all a nivel de AgentRunner.run() con la misma idempotencyKey nunca duplica el efecto", async () => {
    const deps = makeDeps();
    let inFlight = 0;
    let maxConcurrent = 0;
    const handler = vi.fn(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // Cede el control del microtask/macrotask antes de resolver, para
      // maximizar la ventana de una posible condición de carrera real.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { count: 42 };
    });
    deps.registry.register(readTool({ handler }));
    const runner = new AgentRunner(deps);

    const requestA = baseRequest({
      actorId: "user-a",
      steps: [{ toolName: "list_tenders", input: { q: "x" }, idempotencyKey: "race-job-1" }],
    });
    const requestB = baseRequest({
      actorId: "user-b",
      steps: [{ toolName: "list_tenders", input: { q: "x" }, idempotencyKey: "race-job-1" }],
    });

    const [runA, runB] = await Promise.all([runner.run(requestA), runner.run(requestB)]);

    // El handler se invoca una sola vez sin importar cuál corrida "gana" la carrera.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);
    // Ambas corridas terminan en un estado terminal válido: la que ejecutó
    // completa "completed"; la otra recibe el error de "en curso" y falla,
    // pero ninguna de las dos queda colgada ni duplica el efecto.
    const statuses = [runA.status, runB.status].sort();
    expect(statuses).toContain("completed");
  });
});

describe("AgentRunner: reintentos con backoff", () => {
  it("reintenta un paso que falla transitoriamente y termina en éxito, registrando los intentos", async () => {
    const deps = makeDeps({
      defaultRetryPolicy: new RetryPolicy({ maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitter: false }),
    });
    let calls = 0;
    const handler = vi.fn(async () => {
      calls++;
      if (calls < 2) throw new RetryableProviderError("503", 503);
      return { count: 1 };
    });
    deps.registry.register(readTool({ handler }));
    const runner = new AgentRunner(deps);

    const run = await runner.run(baseRequest({ steps: [{ toolName: "list_tenders", input: { q: "x" } }] }));
    expect(run.status).toBe("completed");
    const [trace] = await deps.toolCallStore.listToolCalls(run.id);
    expect(trace.attempts).toBe(2);
  });
});

describe("AgentRunner: presupuesto", () => {
  it("rechaza un paso si excede el presupuesto de la organización", async () => {
    const deps = makeDeps();
    deps.budgetLedger.setLimit("org-1", 0.0001);
    deps.registry.register(readTool());
    const runner = new AgentRunner(deps);

    const run = await runner.run(
      baseRequest({ steps: [{ toolName: "list_tenders", input: { q: "x" }, estimatedCostUsd: 5 }] }),
    );

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/BudgetExceededError/);
  });
});

describe("AgentRunner: presupuesto — AG-08 saneamiento de costo negativo/NaN", () => {
  it("un estimatedCostUsd negativo nunca se reserva/persiste sin sanear: la corrida falla en vez de completarse", async () => {
    const deps = makeDeps();
    deps.registry.register(readTool());
    const runner = new AgentRunner(deps);

    const run = await runner.run(
      baseRequest({ steps: [{ toolName: "list_tenders", input: { q: "x" }, estimatedCostUsd: -5 }] }),
    );

    expect(run.status).toBe("failed");
    const [trace] = await deps.toolCallStore.listToolCalls(run.id);
    expect(trace.status).toBe("error");
    // Nunca se persiste un costo negativo en la traza.
    expect(trace.estimatedCostUsd).toBeGreaterThanOrEqual(0);
  });

  it("un estimatedCostUsd NaN también falla en vez de corromper el ledger silenciosamente", async () => {
    const deps = makeDeps();
    deps.registry.register(readTool());
    const runner = new AgentRunner(deps);

    const run = await runner.run(
      baseRequest({ steps: [{ toolName: "list_tenders", input: { q: "x" }, estimatedCostUsd: NaN }] }),
    );

    expect(run.status).toBe("failed");
  });
});

describe("AgentRunner: rate limit", () => {
  it("un rate limiter agotado hace fallar el paso tras agotar reintentos", async () => {
    const deps = makeDeps({
      rateLimiter: new TokenBucketRateLimiter(0, 0),
      defaultRetryPolicy: new RetryPolicy({ maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 }),
    });
    deps.registry.register(readTool());
    const runner = new AgentRunner(deps);

    const run = await runner.run(baseRequest({ steps: [{ toolName: "list_tenders", input: { q: "x" } }] }));
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/RateLimitExceededError/);
  });
});

describe("AgentRunner: timeout y cancelación", () => {
  it("un paso que excede timeoutMsPerStep termina en timed_out", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      deps.registry.register(
        readTool({
          handler: () => new Promise((resolve) => setTimeout(() => resolve({ count: 1 }), 10_000)),
        }),
      );
      const runner = new AgentRunner(deps);

      const promise = runner.run(
        baseRequest({ timeoutMsPerStep: 50, steps: [{ toolName: "list_tenders", input: { q: "x" } }] }),
      );
      await vi.advanceTimersByTimeAsync(60);
      const run = await promise;
      expect(run.status).toBe("timed_out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancela la corrida de inmediato si el AbortSignal ya está abortado antes del primer paso", async () => {
    const deps = makeDeps();
    deps.registry.register(readTool());
    const runner = new AgentRunner(deps);
    const controller = new AbortController();
    controller.abort();

    const run = await runner.run(
      baseRequest({ signal: controller.signal, steps: [{ toolName: "list_tenders", input: { q: "x" } }] }),
    );
    expect(run.status).toBe("cancelled");
  });

  it("cancela una ejecución en curso cuando se aborta la señal a medias", async () => {
    const deps = makeDeps();
    const controller = new AbortController();
    deps.registry.register(
      readTool({
        handler: () => new Promise((resolve) => setTimeout(() => resolve({ count: 1 }), 5000)),
      }),
    );
    const runner = new AgentRunner(deps);

    const promise = runner.run(
      baseRequest({ signal: controller.signal, steps: [{ toolName: "list_tenders", input: { q: "x" } }] }),
    );
    controller.abort();
    const run = await promise;
    expect(run.status).toBe("cancelled");
  });
});

describe("AgentRunner: no-fabricación de datos sensibles", () => {
  it("un valor sensible sin approvedSourceRef deja el paso pendiente/no evaluable, nunca 'ok'", async () => {
    const deps = makeDeps();
    deps.registry.register(
      readTool({
        name: "compute_price",
        outputSchema: z.object({ price: z.number(), approvedSourceRef: z.unknown().nullable() }),
        handler: async () => ({ price: 1000, approvedSourceRef: null }),
        extractSensitiveValues: (output: { price: number; approvedSourceRef: unknown }) => [
          {
            kind: "precio",
            fieldName: "price",
            value: output.price,
            approvedSourceRef: output.approvedSourceRef as null,
          },
        ],
      }),
    );
    const runner = new AgentRunner(deps);

    const run = await runner.run(baseRequest({ steps: [{ toolName: "compute_price", input: { q: "x" } }] }));
    expect(run.status).toBe("needs_data");
    const [trace] = await deps.toolCallStore.listToolCalls(run.id);
    expect(trace.status).toBe("pending_no_fabrication");
    expect(trace.missingSourcedFields).toEqual(["price"]);
  });

  it("un valor sensible con approvedSourceRef completo se marca 'ok' normalmente", async () => {
    const deps = makeDeps();
    deps.registry.register(
      readTool({
        name: "compute_price",
        outputSchema: z.object({ price: z.number() }),
        handler: async () => ({ price: 1000 }),
        extractSensitiveValues: (output: { price: number }) => [
          {
            kind: "precio",
            fieldName: "price",
            value: output.price,
            approvedSourceRef: { docId: "doc-1", capturedAt: "2026-01-01T00:00:00.000Z" },
          },
        ],
      }),
    );
    const runner = new AgentRunner(deps);
    const run = await runner.run(baseRequest({ steps: [{ toolName: "compute_price", input: { q: "x" } }] }));
    expect(run.status).toBe("completed");
  });
});

describe("AgentRunner: no-fabricación — AG-10 evaluación por defecto (no opt-in)", () => {
  it("un valor sensible SIN declarar extractSensitiveValues, bajo otro nombre y anidado en un array, ya NO completa silenciosamente", async () => {
    const deps = makeDeps();
    deps.registry.register(
      readTool({
        name: "compute_price_leaky",
        outputSchema: z.object({
          items: z.array(z.object({ costo: z.number(), vigente_hasta: z.string() })),
        }),
        handler: async () => ({ items: [{ costo: 1000, vigente_hasta: "2026-12-31" }] }),
        // Deliberadamente SIN extractSensitiveValues: el hueco que auditó AG-10.
      }),
    );
    const runner = new AgentRunner(deps);

    const run = await runner.run(baseRequest({ steps: [{ toolName: "compute_price_leaky", input: { q: "x" } }] }));

    expect(run.status).toBe("needs_data");
    const [trace] = await deps.toolCallStore.listToolCalls(run.id);
    expect(trace.status).toBe("pending_no_fabrication");
    expect(trace.missingSourcedFields?.length).toBeGreaterThan(0);
  });

  it("un output sin ningún campo sensible sigue completando normalmente (sin falsos positivos)", async () => {
    const deps = makeDeps();
    deps.registry.register(readTool());
    const runner = new AgentRunner(deps);
    const run = await runner.run(baseRequest({ steps: [{ toolName: "list_tenders", input: { q: "x" } }] }));
    expect(run.status).toBe("completed");
  });
});

describe("AgentRunner: invalidación por dependencia", () => {
  it("un cambio de bases/plazo invalida una corrida antes de arrancar", async () => {
    const dependencyRegistry = new DependencyInvalidationRegistry();
    const deps = makeDeps({ dependencyRegistry });
    deps.registry.register(readTool());
    const runner = new AgentRunner(deps);

    // Primero registra la dependencia arrancando (y deteniendo antes) una corrida.
    const firstRun = await runner.run(
      baseRequest({
        dependsOn: [{ key: "convocatoria-1:bases", version: "v1" }],
        actorRole: "director",
        steps: [{ toolName: "list_tenders", input: { q: "x" }, }],
      }),
    );
    expect(firstRun.status).toBe("completed");

    // Registrar una segunda corrida que depende de la misma bases v1, pero
    // dejarla pendiente de aprobación antes de invalidar.
    deps.registry.register(readTool({ name: "issue_package", riskLevel: "irreversible" }));
    const pendingRun = await runner.run(
      baseRequest({
        actorRole: "director",
        dependsOn: [{ key: "convocatoria-1:bases", version: "v1" }],
        steps: [{ toolName: "issue_package", input: { q: "x" } }],
      }),
    );
    expect(pendingRun.status).toBe("needs_approval");

    dependencyRegistry.invalidate("convocatoria-1:bases", "v2", "bases_republicadas");

    const resumed = await runner.resume(pendingRun.id, "approve", "director-1");
    expect(resumed.status).toBe("invalidated");
  });

  it("DependencyInvalidationRegistry.invalidate() es idempotente por runId", () => {
    const registry = new DependencyInvalidationRegistry();
    registry.registerDependency("run-1", "bases:1", "v1");
    const first = registry.invalidate("bases:1", "v2", "cambio");
    const second = registry.invalidate("bases:1", "v3", "otro-cambio");
    expect(first).toEqual(["run-1"]);
    expect(second).toEqual([]); // ya estaba invalidado, no se reporta dos veces
    expect(registry.getInvalidation("run-1")?.newVersion).toBe("v2");
  });
});
