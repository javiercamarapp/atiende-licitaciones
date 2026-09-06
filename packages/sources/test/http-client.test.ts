import { describe, expect, it, vi } from "vitest";
import { HostPausedError, HttpClient, HttpError } from "../src/http/http-client.js";
import type { Clock } from "../src/http/host-throttle.js";

function makeManualClock(): Clock & { advance: (ms: number) => Promise<void> } {
  let now = 0;
  let pending: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        pending.push({ at: now + ms, resolve });
      }),
    advance: async (ms: number) => {
      now += ms;
      const ready = pending.filter((p) => p.at <= now);
      pending = pending.filter((p) => p.at > now);
      for (const p of ready) p.resolve();
      // deja que las promesas resueltas avancen microtasks
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "Content-Type": "application/json", ...init.headers } });
}

describe("HttpClient", () => {
  it("reintenta 5xx con backoff exponencial y jitter determinista, y termina en éxito", async () => {
    const clock = makeManualClock();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("boom", { status: 503 });
      return jsonResponse({ ok: true });
    });

    const client = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock,
      random: () => 0.5,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 10_000,
      maxRetries: 5,
      minIntervalMsPerHost: 0,
    });

    const promise = client.request("https://example.com/api");
    // Deja que el primer intento (falla) programe el sleep, luego avanza el reloj manualmente.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
      await clock.advance(100_000);
    }
    const response = await promise;
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
  });

  it("respeta Retry-After en vez del backoff exponencial", async () => {
    const clock = makeManualClock();
    const sleepSpy = vi.fn(clock.sleep);
    const clockWithSpy: Clock = { now: clock.now, sleep: sleepSpy };
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("wait", { status: 429, headers: { "Retry-After": "7" } });
      return jsonResponse({ ok: true });
    });

    const client = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: clockWithSpy,
      random: () => 0,
      minIntervalMsPerHost: 0,
    });

    const promise = client.request("https://example.com/api");
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
      await clock.advance(7000);
    }
    await promise;

    expect(sleepSpy).toHaveBeenCalledWith(7000);
  });

  it("lanza HttpError tras agotar los reintentos", async () => {
    const clock = makeManualClock();
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const client = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock,
      random: () => 0,
      maxRetries: 2,
      retryBaseDelayMs: 10,
      minIntervalMsPerHost: 0,
    });

    const promise = client.request("https://example.com/api").catch((e) => e);
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
      await clock.advance(10_000);
    }
    const error = await promise;
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // intento inicial + 2 reintentos
  });

  it("pausa el host tras 403 consecutivos y no reintenta automáticamente", async () => {
    const clock = makeManualClock();
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const client = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock,
      forbiddenPauseThreshold: 2,
      minIntervalMsPerHost: 0,
      maxRetries: 0,
    });

    await expect(client.request("https://blocked.example.com/")).rejects.toBeInstanceOf(HttpError);
    await expect(client.request("https://blocked.example.com/")).rejects.toBeInstanceOf(HostPausedError);
    // Un tercer intento ni siquiera llama a fetch: el host está en pausa total.
    await expect(client.request("https://blocked.example.com/")).rejects.toBeInstanceOf(HostPausedError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    client.resetHostPause("blocked.example.com");
    expect(client.isHostPaused("blocked.example.com")).toBe(false);
  });

  it("respeta el límite de concurrencia por host", async () => {
    const clock = makeManualClock();
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
      return jsonResponse({ ok: true });
    });

    const client = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock,
      concurrencyPerHost: 2,
      minIntervalMsPerHost: 0,
    });

    await Promise.all(Array.from({ length: 6 }, () => client.request("https://example.com/x")));
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("agrega el User-Agent configurado", async () => {
    let capturedHeaders: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Headers;
      return jsonResponse({ ok: true });
    });
    const client = new HttpClient({ userAgent: "AtiendeLicitacionesBot/1.0 (+https://atiende.mx/bot)", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });
    await client.request("https://example.com/a");
    expect(capturedHeaders?.get("User-Agent")).toBe("AtiendeLicitacionesBot/1.0 (+https://atiende.mx/bot)");
  });
});
