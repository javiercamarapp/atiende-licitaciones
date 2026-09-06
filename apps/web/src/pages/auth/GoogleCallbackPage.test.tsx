import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";

import { renderWithProviders } from "@/test/utils";
import { server } from "@/test/msw";
import { mockGoogleCallback, mockGoogleVerify2fa, mockSessionHydration } from "@/test/googleAuthMocks";
import GoogleCallbackPage from "@/pages/auth/GoogleCallbackPage";

/** Marcadores de destino — evita depender de las pantallas reales (/panel, /sin-acceso, /login) solo para comprobar a dónde navegó. */
function renderCallback(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/auth/google/callback" element={<GoogleCallbackPage />} />
      <Route path="/panel" element={<p>Panel real</p>} />
      <Route path="/sin-acceso" element={<p>Pantalla sin acceso</p>} />
      <Route path="/login" element={<p>Pantalla de login</p>} />
    </Routes>,
    { route },
  );
}

describe("GoogleCallbackPage (REQ-172..180)", () => {
  it("state ausente en la URL: error honesto sin llamar a la API", async () => {
    renderCallback("/auth/google/callback?code=abc");
    expect(await screen.findByText(/Falta el parámetro state/)).toBeInTheDocument();
  });

  it("status ok: completa la sesión y navega a /panel", async () => {
    server.use(mockGoogleCallback({ status: "ok" }), ...mockSessionHydration({ memberships: [{ id: "org-1", name: "Org", slug: "org", role: "owner" }] }));
    renderCallback("/auth/google/callback?code=abc123&state=state-1");
    expect(await screen.findByText("Panel real")).toBeInTheDocument();
  });

  it("status sin_acceso (REQ-174/D-09): navega a /sin-acceso, nunca a /panel", async () => {
    server.use(mockGoogleCallback({ status: "sin_acceso" }), ...mockSessionHydration({ memberships: [] }));
    renderCallback("/auth/google/callback?code=abc123&state=state-2");
    expect(await screen.findByText("Pantalla sin acceso")).toBeInTheDocument();
  });

  it("status requires_2fa (REQ-176): muestra el segundo factor y, tras verificarlo, completa la sesión", async () => {
    server.use(
      mockGoogleCallback({ status: "requires_2fa", pendingToken: "pending-token-1" }),
      mockGoogleVerify2fa({ status: "ok" }),
      ...mockSessionHydration({ memberships: [{ id: "org-1", name: "Org", slug: "org", role: "owner" }] }),
    );
    const user = userEvent.setup();
    renderCallback("/auth/google/callback?code=abc123&state=state-3");

    expect(await screen.findByRole("heading", { name: "Verificación en dos pasos" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Código TOTP o de respaldo"), "123456");
    await user.click(screen.getByRole("button", { name: "Verificar y continuar" }));

    expect(await screen.findByText("Panel real")).toBeInTheDocument();
  });

  it("REQ-176 adversarial: un código de verificación incorrecto muestra el mensaje real y no navega", async () => {
    server.use(
      mockGoogleCallback({ status: "requires_2fa", pendingToken: "pending-token-2" }),
      mockGoogleVerify2fa({ httpStatus: 403, title: "Código TOTP inválido, o ya fue utilizado (replay rechazado)." }),
    );
    const user = userEvent.setup();
    renderCallback("/auth/google/callback?code=abc123&state=state-4");

    await screen.findByRole("heading", { name: "Verificación en dos pasos" });
    await user.type(screen.getByLabelText("Código TOTP o de respaldo"), "000000");
    await user.click(screen.getByRole("button", { name: "Verificar y continuar" }));

    expect(await screen.findByText(/Código TOTP inválido/)).toBeInTheDocument();
    expect(screen.queryByText("Panel real")).not.toBeInTheDocument();
  });

  it("REQ-180 adversarial: 403 de conflicto de identidad se muestra con el mensaje real de la API", async () => {
    server.use(
      mockGoogleCallback({
        httpStatus: 403,
        title: "Esta cuenta ya tiene una identidad de Google distinta vinculada; contacte a soporte.",
        requestId: "req-conflict-1",
      }),
    );
    renderCallback("/auth/google/callback?code=abc123&state=state-5");

    expect(await screen.findByText(/identidad de Google distinta vinculada/)).toBeInTheDocument();
    expect(screen.getByText(/req-conflict-1/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver al inicio de sesión" })).toHaveAttribute("href", "/login");
  });

  it("REQ-178 adversarial: 503 (Google no configurado) también en el callback se muestra honesto", async () => {
    server.use(mockGoogleCallback({ httpStatus: 503, title: "Login con Google no configurado." }));
    renderCallback("/auth/google/callback?code=abc123&state=state-6");

    expect(await screen.findByText(/Login con Google no configurado/)).toBeInTheDocument();
  });

  it("adversarial: state inválido/expirado (400 real de apps/api) se muestra honesto", async () => {
    server.use(mockGoogleCallback({ httpStatus: 400, title: "El parámetro state ya fue utilizado o expiró (posible reintento/CSRF)." }));
    renderCallback("/auth/google/callback?code=abc123&state=state-ya-usado");

    expect(await screen.findByText(/state ya fue utilizado o expiró/)).toBeInTheDocument();
  });
});
