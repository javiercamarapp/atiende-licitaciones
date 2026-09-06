import { describe, expect, it } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

import { server, http, HttpResponse } from "@/test/msw";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { getTokens } from "@/lib/api/session";
import { queryClient } from "@/lib/queryClient";

function wrapper({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe("useAuth", () => {
  it("arranca en 'unauthenticated' cuando no hay refresh token guardado (sin llamar a la red)", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
    expect(result.current.user).toBeNull();
    expect(result.current.memberships).toEqual([]);
  });

  it("login: éxito real hidrata usuario + memberships y selecciona la primera organización", async () => {
    server.use(
      http.post("*/auth/login", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
      http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "persona@empresa.com", fullName: "Persona" })),
      http.get("*/organizations", () =>
        HttpResponse.json([
          { id: "org-a", name: "Organización A", slug: "org-a", role: "owner" },
          { id: "org-b", name: "Organización B", slug: "org-b", role: "writer" },
        ]),
      ),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));

    await act(async () => {
      await result.current.login({ email: "persona@empresa.com", password: "contraseñaValida123" });
    });

    expect(result.current.status).toBe("authenticated");
    expect(result.current.user?.email).toBe("persona@empresa.com");
    expect(result.current.memberships).toHaveLength(2);
    expect(result.current.currentOrgId).toBe("org-a");
    expect(getTokens().accessToken).toBe("acc-1");
  });

  it("login: credenciales inválidas (401) no deja una sesión a medias", async () => {
    server.use(
      http.post("*/auth/login", () =>
        HttpResponse.json({ type: "unauthorized", title: "Credenciales inválidas", status: 401, requestId: "req-1" }, { status: 401 }),
      ),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));

    await act(async () => {
      await expect(result.current.login({ email: "persona@empresa.com", password: "mala" })).rejects.toMatchObject({ status: 401 });
    });

    expect(result.current.status).toBe("unauthenticated");
    expect(result.current.user).toBeNull();
  });

  it("switchOrg: solo acepta una organización real de memberships (X-Org-Id nunca se envía a una org ajena)", async () => {
    server.use(
      http.post("*/auth/login", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
      http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "persona@empresa.com", fullName: null })),
      http.get("*/organizations", () =>
        HttpResponse.json([
          { id: "org-a", name: "Organización A", slug: "org-a", role: "owner" },
          { id: "org-b", name: "Organización B", slug: "org-b", role: "writer" },
        ]),
      ),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
    await act(async () => {
      await result.current.login({ email: "persona@empresa.com", password: "contraseñaValida123" });
    });

    act(() => result.current.switchOrg("org-b"));
    expect(result.current.currentOrgId).toBe("org-b");
    expect(result.current.currentMembership?.role).toBe("writer");

    act(() => result.current.switchOrg("org-ajena-no-existe"));
    // No cambia: sigue en org-b (la última organización válida seleccionada).
    expect(result.current.currentOrgId).toBe("org-b");
  });

  it("logout: revoca el refresh token y limpia la sesión local", async () => {
    let logoutCalledWith: string | null = null;
    server.use(
      http.post("*/auth/login", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
      http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "persona@empresa.com", fullName: null })),
      http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
      http.post("*/auth/logout", async ({ request }) => {
        const body = (await request.json()) as { refreshToken: string };
        logoutCalledWith = body.refreshToken;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
    await act(async () => {
      await result.current.login({ email: "persona@empresa.com", password: "contraseñaValida123" });
    });

    await act(async () => {
      await result.current.logout();
    });

    expect(logoutCalledWith).toBe("ref-1");
    expect(result.current.status).toBe("unauthenticated");
    expect(getTokens()).toEqual({ accessToken: null, refreshToken: null });
  });

  // WI-03 (docs/auditoria-2/web-integrado.md): logout() no llamaba a
  // queryClient.clear() — las queries admin/globales (sin `currentOrgId` en
  // su clave) sobrevivían en caché y podían pintar datos de la sesión
  // anterior en un navegador compartido.
  it("logout: limpia TODO el caché de react-query (queryClient.clear())", async () => {
    server.use(
      http.post("*/auth/login", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
      http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "persona@empresa.com", fullName: null })),
      http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
      http.post("*/auth/logout", () => new HttpResponse(null, { status: 204 })),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
    await act(async () => {
      await result.current.login({ email: "persona@empresa.com", password: "contraseñaValida123" });
    });

    // Simula datos admin/globales en caché de la sesión que termina (no
    // tienen `currentOrgId` en su clave, ver src/hooks/useAdmin.ts).
    queryClient.setQueryData(["admin", "organizations"], [{ id: "org-x" }]);
    queryClient.setQueryData(["tenders", "sources-freshness"], [{ source: "diario-oficial" }]);
    expect(queryClient.getQueryData(["admin", "organizations"])).toBeDefined();

    await act(async () => {
      await result.current.logout();
    });

    expect(queryClient.getQueryData(["admin", "organizations"])).toBeUndefined();
    expect(queryClient.getQueryData(["tenders", "sources-freshness"])).toBeUndefined();
  });

  // WI-03: un cambio de organización tampoco debe dejar residuo visible de
  // las queries admin/globales (las de negocio ya son seguras porque
  // incluyen `currentOrgId` en su clave — ver rubro 2 de la auditoría).
  it("switchOrg: elimina las queries admin/globales sin `currentOrgId` en su clave", async () => {
    server.use(
      http.post("*/auth/login", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
      http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "persona@empresa.com", fullName: null })),
      http.get("*/organizations", () =>
        HttpResponse.json([
          { id: "org-a", name: "Organización A", slug: "org-a", role: "owner" },
          { id: "org-b", name: "Organización B", slug: "org-b", role: "writer" },
        ]),
      ),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("unauthenticated"));
    await act(async () => {
      await result.current.login({ email: "persona@empresa.com", password: "contraseñaValida123" });
    });

    queryClient.setQueryData(["admin", "incidents"], [{ id: "inc-1" }]);
    // Query de negocio SÍ namespaced por org — no debe eliminarse al
    // cambiar de organización (el diseño de queryKey ya la aísla).
    queryClient.setQueryData(["company", "rates", "org-a"], [{ id: "rate-1" }]);

    act(() => result.current.switchOrg("org-b"));

    expect(queryClient.getQueryData(["admin", "incidents"])).toBeUndefined();
    expect(queryClient.getQueryData(["company", "rates", "org-a"])).toBeDefined();
  });
});
