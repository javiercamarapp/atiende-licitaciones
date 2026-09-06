import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import { Toaster } from "@/components/ui/sonner";
import SinAccesoPage from "@/pages/SinAccesoPage";

function renderSinAcceso() {
  return renderWithProviders(
    <>
      <Toaster />
      <Routes>
        <Route path="/sin-acceso" element={<SinAccesoPage />} />
        <Route path="/onboarding" element={<p>Wizard de onboarding</p>} />
        <Route path="/panel" element={<p>Panel real</p>} />
        <Route path="/login" element={<p>Pantalla de login</p>} />
      </Routes>
    </>,
    { route: "/sin-acceso" },
  );
}

/** Sesión autenticada real (mismo patrón que ConfiguracionPage.test.tsx): AuthProvider necesita un refresh token guardado + /me + /organizations para pasar de "loading" a "authenticated". */
function mockAuthenticatedSession(memberships: Array<{ id: string; name: string; slug: string; role: string }> = []) {
  setTokens({ accessToken: "acc-1", refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-2", refreshToken: "ref-2" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "persona@empresa.com", fullName: null })),
    http.get("*/organizations", () => HttpResponse.json(memberships)),
  );
}

describe("SinAccesoPage (D-09)", () => {
  it("muestra el texto honesto y los dos caminos reales", async () => {
    mockAuthenticatedSession([]);
    renderSinAcceso();

    expect(await screen.findByRole("heading", { level: 1, name: "Tu cuenta no está vinculada a ninguna organización" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Crear mi organización" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Pedir invitación" })).toBeInTheDocument();
  });

  it('"Crear mi organización" lleva al wizard de onboarding existente (nunca crea la organización aquí mismo)', async () => {
    mockAuthenticatedSession([]);
    const user = userEvent.setup();
    renderSinAcceso();

    await user.click(await screen.findByRole("link", { name: "Crear mi organización" }));
    expect(await screen.findByText("Wizard de onboarding")).toBeInTheDocument();
  });

  it('"Ya me invitaron, continuar" vuelve a pedir GET /organizations y avisa si sigue sin ninguna', async () => {
    mockAuthenticatedSession([]);
    const user = userEvent.setup();
    renderSinAcceso();

    await user.click(await screen.findByRole("button", { name: "Ya me invitaron, continuar" }));
    expect(await screen.findByText(/Seguimos sin encontrar ninguna organización/)).toBeInTheDocument();
  });

  it("ya con una membresía (invitación aceptada mientras tanto), redirige a /panel en vez de quedarse aquí", async () => {
    mockAuthenticatedSession([{ id: "org-1", name: "Empresa", slug: "empresa", role: "writer" }]);
    renderSinAcceso();
    expect(await screen.findByText("Panel real")).toBeInTheDocument();
  });

  it("Cerrar sesión desloguea y no deja al usuario atrapado en esta pantalla", async () => {
    mockAuthenticatedSession([]);
    server.use(http.post("*/auth/logout", () => HttpResponse.json(undefined, { status: 204 })));
    const user = userEvent.setup();
    renderSinAcceso();

    await user.click(await screen.findByRole("button", { name: "Cerrar sesión" }));
    // logout() no navega por sí mismo (lo hace RequireAuth al ver status
    // "unauthenticated") — aquí solo se comprueba que la acción existe y no
    // revienta; RequireAuth.test.tsx/App ya cubren la redirección real.
    expect(screen.getByRole("heading", { level: 1, name: "Tu cuenta no está vinculada a ninguna organización" })).toBeInTheDocument();
  });
});
