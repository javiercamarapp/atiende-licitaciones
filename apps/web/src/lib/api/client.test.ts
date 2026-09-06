import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server, http, HttpResponse } from "@/test/msw";
import { apiRequest } from "@/lib/api/client";
import { ApiError } from "@/lib/api/http";
import { clearTokens, getTokens, setTokens } from "@/lib/api/session";

// Cliente API tipado (src/lib/api/client.ts): éxito, 401→refresh→reintento
// (rotación real de tokens, ver apps/api/src/modules/auth/routes.ts), 403,
// 500 con request_id, y red caída — con MSW simulando apps/api. Ninguno de
// estos escenarios usa un backend real (eso lo cubre la suite E2E,
// test:e2e:full, contra apps/api real con PGlite).
describe("apiRequest", () => {
  beforeEach(() => {
    setTokens({ accessToken: "access-1", refreshToken: "refresh-1" });
  });

  afterEach(() => {
    clearTokens();
  });

  it("éxito: agrega Authorization y X-Org-Id, y devuelve el JSON tal cual", async () => {
    let receivedAuth: string | null = null;
    let receivedOrg: string | null = null;
    server.use(
      http.get("*/company/profile", ({ request }) => {
        receivedAuth = request.headers.get("authorization");
        receivedOrg = request.headers.get("x-org-id");
        return HttpResponse.json({ id: "profile-1", legalName: "Empresa Real S.A. de C.V." });
      }),
    );

    const result = await apiRequest<{ id: string; legalName: string }>("/company/profile", { orgId: "org-1" });

    expect(result).toEqual({ id: "profile-1", legalName: "Empresa Real S.A. de C.V." });
    expect(receivedAuth).toBe("Bearer access-1");
    expect(receivedOrg).toBe("org-1");
  });

  it("401 → refresca el token una vez y reintenta la petición original con el token nuevo", async () => {
    let attempt = 0;
    server.use(
      http.get("*/tenders/sources/freshness", ({ request }) => {
        attempt += 1;
        const auth = request.headers.get("authorization");
        if (attempt === 1) {
          expect(auth).toBe("Bearer access-1");
          return HttpResponse.json(
            { type: "unauthorized", title: "Token de acceso inválido o expirado", status: 401, requestId: "req-401" },
            { status: 401 },
          );
        }
        expect(auth).toBe("Bearer access-2");
        return HttpResponse.json([]);
      }),
      http.post("*/auth/refresh", async ({ request }) => {
        const body = (await request.json()) as { refreshToken: string };
        expect(body.refreshToken).toBe("refresh-1");
        return HttpResponse.json({ accessToken: "access-2", refreshToken: "refresh-2" });
      }),
    );

    const result = await apiRequest<unknown[]>("/tenders/sources/freshness");

    expect(result).toEqual([]);
    expect(attempt).toBe(2);
    expect(getTokens()).toEqual({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("401 con refresh también inválido: limpia la sesión y propaga el 401 original", async () => {
    server.use(
      http.get("*/tenders/sources/freshness", () =>
        HttpResponse.json({ type: "unauthorized", title: "Token de acceso inválido o expirado", status: 401, requestId: "req-401" }, { status: 401 }),
      ),
      http.post("*/auth/refresh", () =>
        HttpResponse.json({ type: "unauthorized", title: "Refresh token inválido, expirado o revocado", status: 401, requestId: "req-402" }, { status: 401 }),
      ),
    );

    await expect(apiRequest("/tenders/sources/freshness")).rejects.toMatchObject({ status: 401 });
    expect(getTokens()).toEqual({ accessToken: null, refreshToken: null });
  });

  it("403: propaga el mensaje real y el request_id de la API (permiso denegado)", async () => {
    server.use(
      http.get("*/admin/organizations", () =>
        HttpResponse.json(
          { type: "forbidden", title: "Esta acción requiere privilegios de superadmin de plataforma", status: 403, requestId: "req-403" },
          { status: 403 },
        ),
      ),
    );

    const err = await apiRequest("/admin/organizations").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).message).toBe("Esta acción requiere privilegios de superadmin de plataforma");
    expect((err as ApiError).requestId).toBe("req-403");
  });

  it("500: propaga el mensaje real y el request_id sin inventar contenido", async () => {
    server.use(
      http.get("*/company/documents", () =>
        HttpResponse.json({ type: "internal-server-error", title: "Error interno del servidor", status: 500, requestId: "req-500" }, { status: 500 }),
      ),
    );

    const err = await apiRequest("/company/documents", { orgId: "org-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).requestId).toBe("req-500");
  });

  it("red caída: lanza ApiError con mensaje honesto de conexión, sin status", async () => {
    server.use(http.get("*/tenders", () => HttpResponse.error()));

    const err = await apiRequest("/tenders", { orgId: "org-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toMatch(/no se pudo conectar/i);
    expect((err as ApiError).status).toBeUndefined();
  });

  it("sin sesión (sin access token) y sin skipAuth: falla honesto sin llegar a la red", async () => {
    clearTokens();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const err = await apiRequest("/tenders", { orgId: "org-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
