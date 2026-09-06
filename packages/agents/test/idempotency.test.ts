import { describe, expect, it, vi } from "vitest";
import { IdempotencyStore } from "../src/idempotency.js";
import { IdempotencyInProgressError } from "../src/errors.js";

describe("IdempotencyStore", () => {
  it("misma clave [organizationId, idempotencyKey] retorna el mismo resultado sin ejecutar de nuevo (REQ-073)", async () => {
    const store = new IdempotencyStore();
    const fn = vi.fn().mockResolvedValue({ ok: true, value: 42 });

    const first = await store.withIdempotency("org-1", "key-1", fn);
    const second = await store.withIdempotency("org-1", "key-1", fn);

    expect(first).toEqual({ ok: true, value: 42 });
    expect(second).toBe(first);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("distingue por organización: la misma clave en otra org sí ejecuta de nuevo", async () => {
    const store = new IdempotencyStore();
    const fn = vi.fn().mockResolvedValueOnce("resultado-org-1").mockResolvedValueOnce("resultado-org-2");

    const r1 = await store.withIdempotency("org-1", "key-1", fn);
    const r2 = await store.withIdempotency("org-2", "key-1", fn);

    expect(r1).toBe("resultado-org-1");
    expect(r2).toBe("resultado-org-2");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("trata organizationId null como su propio espacio ('platform')", async () => {
    const store = new IdempotencyStore();
    const fn = vi.fn().mockResolvedValue("plataforma");
    await store.withIdempotency(null, "key-1", fn);
    await store.withIdempotency(null, "key-1", fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("una ejecución concurrente con la misma clave lanza IdempotencyInProgressError en vez de ejecutar dos veces", async () => {
    const store = new IdempotencyStore();
    let resolveFirst!: (value: string) => void;
    const firstPromise = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const fn = vi.fn().mockReturnValue(firstPromise);

    const inFlight = store.withIdempotency("org-1", "key-1", fn);
    await expect(store.withIdempotency("org-1", "key-1", fn)).rejects.toThrow(IdempotencyInProgressError);

    resolveFirst("listo");
    await expect(inFlight).resolves.toBe("listo");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("libera la clave si la ejecución falla, permitiendo un reintento posterior", async () => {
    const store = new IdempotencyStore();
    const fn = vi.fn().mockRejectedValueOnce(new Error("falla transitoria")).mockResolvedValueOnce("ok-en-el-reintento");

    await expect(store.withIdempotency("org-1", "key-1", fn)).rejects.toThrow("falla transitoria");
    const result = await store.withIdempotency("org-1", "key-1", fn);

    expect(result).toBe("ok-en-el-reintento");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("peek() expone el registro sin ejecutar nada", async () => {
    const store = new IdempotencyStore();
    expect(store.peek("org-1", "key-1")).toBeUndefined();
    await store.withIdempotency("org-1", "key-1", async () => "valor");
    expect(store.peek("org-1", "key-1")?.status).toBe("completed");
  });
});
