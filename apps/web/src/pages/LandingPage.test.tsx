import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import { setTokens } from "@/lib/api/session";
import { server, http, HttpResponse } from "@/test/msw";
import LandingPage from "@/pages/LandingPage";

describe("LandingPage", () => {
  it("muestra el hero, cómo funciona, seguridad, casos, planes y FAQ", async () => {
    renderWithProviders(<LandingPage />);

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(/licitación/i);
    expect(screen.getByRole("heading", { name: "Cómo funciona" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Seguridad y reglas de no actuación" })).toBeInTheDocument();
    expect(screen.getByText(/Nunca envía ni presenta una propuesta/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Casos por perfil de empresa" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Planes" })).toBeInTheDocument();
    expect(screen.getAllByText("Próximamente").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Preguntas frecuentes" })).toBeInTheDocument();
  });

  it("el formulario de solicitar demo está deshabilitado (sin backend de contacto)", async () => {
    renderWithProviders(<LandingPage />);
    expect(await screen.findByRole("button", { name: "Enviar solicitud" })).toBeDisabled();
    expect(screen.getByText(/todavía no está conectado a ningún backend de contacto/)).toBeInTheDocument();
  });

  it("enlaza a la demo, al login y a las páginas legales", async () => {
    renderWithProviders(<LandingPage />);
    expect((await screen.findAllByRole("link", { name: /Ver demo sin cuenta/ }))[0]).toHaveAttribute("href", "/demo");
    expect(screen.getAllByRole("link", { name: "Iniciar sesión" })[0]).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Aviso de privacidad" })).toHaveAttribute("href", "/privacidad");
    expect(screen.getByRole("link", { name: "Términos de servicio" })).toHaveAttribute("href", "/legal/terminos");
  });

  it("deja de mostrar la landing en cuanto hay una sesión activa (redirige a /panel)", async () => {
    setTokens({ accessToken: null, refreshToken: "ref-1" });
    server.use(
      http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
      http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
      http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    );

    renderWithProviders(<LandingPage />);

    // Mientras la sesión se resuelve ("loading"), LandingPage sigue
    // mostrando la landing normal (no hay nada más que mostrar todavía);
    // en cuanto AuthProvider resuelve "authenticated", <Navigate/> desmonta
    // todo el contenido de la landing (no hay ninguna <Route path="/panel">
    // en este árbol de prueba -- solo se verifica que deja de renderizarse).
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument());
  });

  it("no tiene violaciones de accesibilidad detectables por axe", async () => {
    renderWithProviders(<LandingPage />);
    await screen.findByRole("main");
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  }, 15000);
});
