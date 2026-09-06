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

describe("HttpClient: redirecciones cross-host (SR-04)", () => {
  /**
   * El mock simula el comportamiento REAL de `fetch`/undici: cuando NO se
   * pide `redirect: "manual"` explícitamente, el redirect se sigue de forma
   * TRANSPARENTE dentro de la misma llamada (el llamador nunca ve el 302 ni
   * el host de destino) — así es como se reprodujo el bug real (§5 de la
   * auditoría, 2 servidores locales). Cuando SÍ se pide `redirect: "manual"`
   * (lo que debe hacer `fetchWithTimeout` tras el fix), el mock devuelve el
   * 302 crudo con su `Location`, para que sea el propio `HttpClient` quien
   * decida si reentra la petición a través de `request()` (y por lo tanto
   * de su throttle por host).
   */
  /**
   * 5 hosts de ORIGEN distintos (a1..a5) redirigen todos al MISMO host de
   * destino (b.example.com). Usar hosts de origen distintos es intencional:
   * si los 5 orígenes fueran el mismo host, el propio throttle POR ORIGEN
   * ya serializaría las 5 llamadas al mock (sin importar si el bug de
   * redirect cross-host está arreglado o no), y el test no distinguiría
   * nada. Con 5 orígenes distintos, el throttle por origen NO limita nada
   * entre sí — solo el throttle del host de DESTINO (b.example.com) puede
   * evitar que las 5 lleguen "concurrentes" a B.
   */
  function makeRedirectingFetchImpl(opts: { onHostBCall: () => void | Promise<void> }) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (/^a\d\.example\.com$/.test(u.host) && u.pathname === "/start") {
        if (init?.redirect === "manual") {
          return new Response(null, { status: 302, headers: { Location: "https://b.example.com/target" } });
        }
        // Comportamiento por defecto de `fetch` (redirect: "follow"): sigue el 302 sin que el
        // llamador se entere, y por lo tanto SIN pasar por el throttle del host b.example.com.
        await opts.onHostBCall();
        return jsonResponse({ ok: true, via: "auto-follow" });
      }
      if (u.host === "b.example.com") {
        await opts.onHostBCall();
        return jsonResponse({ ok: true, via: "manual-refollow" });
      }
      throw new Error(`URL inesperada en el mock: ${url}`);
    });
  }

  it("aplica concurrencyPerHost del host de DESTINO tras una redirección cross-host (antes del fix, el mock ni siquiera expone el 302: se sigue de forma transparente sin límite)", async () => {
    let inFlightB = 0;
    let maxInFlightB = 0;
    const fetchImpl = makeRedirectingFetchImpl({
      onHostBCall: async () => {
        inFlightB += 1;
        maxInFlightB = Math.max(maxInFlightB, inFlightB);
        await new Promise((r) => setTimeout(r, 10));
        inFlightB -= 1;
      },
    });

    const client = new HttpClient({
      userAgent: "TestBot/1.0",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      concurrencyPerHost: 1,
      minIntervalMsPerHost: 0,
    });

    await Promise.all(
      Array.from({ length: 5 }, (_, i) => client.request(`https://a${i + 1}.example.com/start`)),
    );
    expect(maxInFlightB).toBeLessThanOrEqual(1);
  });

  it("no reenvía Authorization/Cookie a un host distinto tras redirigir, pero sí los preserva en un redirect al MISMO host", async () => {
    const capturedAuth: Record<string, string | null> = {};
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const headers = new Headers(init?.headers);
      if (u.host === "a.example.com" && u.pathname === "/cross-host") {
        return new Response(null, { status: 302, headers: { Location: "https://b.example.com/target" } });
      }
      if (u.host === "a.example.com" && u.pathname === "/same-host") {
        return new Response(null, { status: 302, headers: { Location: "https://a.example.com/same-host-target" } });
      }
      if (u.host === "b.example.com") {
        capturedAuth.b = headers.get("Authorization");
        return jsonResponse({ ok: true });
      }
      if (u.host === "a.example.com" && u.pathname === "/same-host-target") {
        capturedAuth.aSameHost = headers.get("Authorization");
        return jsonResponse({ ok: true });
      }
      throw new Error(`URL inesperada: ${url}`);
    });

    const client = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });

    await client.request("https://a.example.com/cross-host", { headers: { Authorization: "Bearer secreto" } });
    expect(capturedAuth.b).toBeNull();

    await client.request("https://a.example.com/same-host", { headers: { Authorization: "Bearer secreto" } });
    expect(capturedAuth.aSameHost).toBe("Bearer secreto");
  });

  it("rechaza seguir una redirección hacia un esquema no-https", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "http://inseguro.example.com/x" } }));
    const client = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });
    await expect(client.request("https://a.example.com/start")).rejects.toThrow(/https/i);
  });

  it("limita el número de saltos de redirección (evita loops infinitos)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const n = Number(new URL(url).searchParams.get("n") ?? "0");
      return new Response(null, { status: 302, headers: { Location: `https://a.example.com/start?n=${n + 1}` } });
    });
    const client = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0, maxRedirects: 3 });
    await expect(client.request("https://a.example.com/start?n=0")).rejects.toThrow(/redirec/i);
  });

  it("sigue una redirección 302 normal (same-host) y devuelve la respuesta final", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://example.com/old") return new Response(null, { status: 302, headers: { Location: "https://example.com/new" } });
      return jsonResponse({ ok: true, from: "new" });
    });
    const client = new HttpClient({ userAgent: "TestBot/1.0", fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMsPerHost: 0 });
    const response = await client.request("https://example.com/old");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, from: "new" });
  });
});
