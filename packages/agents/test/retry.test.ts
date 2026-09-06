import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryPolicy } from "../src/retry.js";
import { classifyError, RetryableProviderError, NonRetryableProviderError, RunCancelledError } from "../src/errors.js";

describe("classifyError", () => {
  it("clasifica 429 y 5xx como reintentables", () => {
    expect(classifyError({ status: 429 })).toBe("retryable");
    expect(classifyError({ status: 500 })).toBe("retryable");
    expect(classifyError({ status: 503 })).toBe("retryable");
  });

  it("clasifica 4xx (salvo 429) como no reintentables", () => {
    expect(classifyError({ status: 400 })).toBe("non_retryable");
    expect(classifyError({ status: 401 })).toBe("non_retryable");
    expect(classifyError({ status: 404 })).toBe("non_retryable");
    expect(classifyError({ status: 422 })).toBe("non_retryable");
  });

  it("respeta el flag `retryable` de AgentsError", () => {
    expect(classifyError(new RetryableProviderError("timeout de red"))).toBe("retryable");
    expect(classifyError(new NonRetryableProviderError("prompt inválido"))).toBe("non_retryable");
  });

  it("un AbortError nunca es reintentable", () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyError(abortError)).toBe("non_retryable");
  });

  it("un error de red desconocido sin status se asume transitorio/reintentable", () => {
    expect(classifyError(new Error("ECONNRESET"))).toBe("retryable");
  });
});

describe("RetryPolicy.computeDelay", () => {
  it("crece exponencialmente en base al número de intento", () => {
    const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 100_000, jitter: false });
    expect(policy.computeDelay(1)).toBe(100);
    expect(policy.computeDelay(2)).toBe(200);
    expect(policy.computeDelay(3)).toBe(400);
    expect(policy.computeDelay(4)).toBe(800);
  });

  it("acota el delay a maxDelayMs", () => {
    const policy = new RetryPolicy({ maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 3000, jitter: false });
    expect(policy.computeDelay(10)).toBe(3000);
  });

  it("aplica jitter completo (0..delay) cuando jitter=true", () => {
    const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 100_000, jitter: true, random: () => 0.5 });
    expect(policy.computeDelay(1)).toBe(500); // 0.5 * 1000
    expect(policy.computeDelay(2)).toBe(1000); // 0.5 * 2000
  });
});

describe("RetryPolicy.execute con fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reintenta con backoff exponencial ante errores reintentables y eventualmente tiene éxito", async () => {
    const policy = new RetryPolicy({ maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 10_000, jitter: false });
    const attempts: number[] = [];
    const fn = vi.fn(async (attempt: number) => {
      attempts.push(attempt);
      if (attempt < 3) throw new RetryableProviderError("503 temporal", 503);
      return "exito-al-tercer-intento";
    });

    const promise = policy.execute(fn);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("exito-al-tercer-intento");
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("no reintenta errores no-reintentables: falla en el primer intento", async () => {
    const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000, jitter: false });
    const fn = vi.fn(async () => {
      throw new NonRetryableProviderError("400 esquema inválido", 400);
    });

    await expect(policy.execute(fn)).rejects.toThrow("400 esquema inválido");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("agota maxAttempts y lanza el último error si nunca tiene éxito", async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 1000, jitter: false });
    const fn = vi.fn(async () => {
      throw new RetryableProviderError("503 persistente", 503);
    });

    const promise = policy.execute(fn);
    // Evita que un rechazo no manejado dispare antes de adjuntar el listener.
    promise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow("503 persistente");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respeta AbortSignal durante la espera de backoff y cancela de inmediato", async () => {
    const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 5000, maxDelayMs: 10_000, jitter: false });
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw new RetryableProviderError("503 temporal", 503);
    });

    const promise = policy.execute(fn, controller.signal, "run-abort");
    promise.catch(() => {});
    // Deja que el primer intento falle y entre en espera de backoff.
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).rejects.toThrow(RunCancelledError);
  });

  it("no ejecuta ni un intento si la señal ya está abortada antes de empezar", async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 });
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn();

    await expect(policy.execute(fn, controller.signal)).rejects.toThrow(RunCancelledError);
    expect(fn).not.toHaveBeenCalled();
  });
});
