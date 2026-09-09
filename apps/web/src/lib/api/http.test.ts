import { describe, expect, it } from "vitest";

import { server, http, HttpResponse } from "@/test/msw";
import { rawRequest, ApiError } from "@/lib/api/http";

/**
 * WB-12 (docs/auditoria-2/web-r7-r8a.md §8): `RegistroPage.test.tsx` traía
 * un comentario que afirmaba que el reintento-con-backoff de 429 de
 * `rawRequest` "ya está cubierto por `client.test.ts`" -- verificado que
 * `client.test.ts` no menciona 429 ni `Retry-After` en ninguna de sus
 * pruebas, y no existía ningún `http.test.ts` dedicado. Este archivo cubre
 * el mecanismo real (no solo que la UI muestre el mensaje final): reintento
 * respetando `Retry-After`, y el límite real de reintentos
 * (`MAX_RATE_LIMIT_RETRIES = 6`) rindiéndose con el `ApiError` 429 real.
 */
describe("rawRequest: reintento de 429 (rate limit transitorio)", () => {
  it("reintenta respetando Retry-After y resuelve con éxito una vez que el límite se despeja", async () => {
    let attempts = 0;
    server.use(
      http.get("*/probe-429", () => {
        attempts += 1;
        if (attempts <= 2) {
          return new HttpResponse(JSON.stringify({ title: "Rate limit exceeded, retry in 1 minute", status: 429 }), {
            status: 429,
            headers: { "content-type": "application/problem+json", "retry-after": "0" },
          });
        }
        return HttpResponse.json({ ok: true });
      }),
    );

    const result = await rawRequest<{ ok: boolean }>("/probe-429");

    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(3);
  }, 10000);

  it("se rinde tras agotar los reintentos y propaga el 429 real como ApiError (no un mensaje inventado)", async () => {
    let attempts = 0;
    server.use(
      http.get("*/probe-429-agotado", () => {
        attempts += 1;
        return new HttpResponse(JSON.stringify({ title: "Rate limit exceeded, retry in 1 minute", status: 429 }), {
          status: 429,
          headers: { "content-type": "application/problem+json", "retry-after": "0" },
        });
      }),
    );

    await expect(rawRequest("/probe-429-agotado")).rejects.toMatchObject({ status: 429 } satisfies Partial<ApiError>);
    // 1 intento inicial + MAX_RATE_LIMIT_RETRIES (6) reintentos = 7 llamadas reales.
    expect(attempts).toBe(7);
  }, 15000);
});
