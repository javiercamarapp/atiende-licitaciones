import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import LoginPage from "@/pages/LoginPage";

describe("LoginPage", () => {
  it("tiene un landmark <main> y un <h1> real (W-08)", async () => {
    renderWithProviders(<LoginPage />);
    expect(await screen.findByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Accede a tu panel de licitaciones" })).toBeInTheDocument();
  });

  it("valida el formulario de contraseña con zod antes de enviar", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.click(await screen.findByRole("button", { name: "Iniciar sesión" }));

    expect(await screen.findByText("Ingresa tu correo electrónico.")).toBeInTheDocument();
    expect(screen.getByText("La contraseña debe tener al menos 8 caracteres.")).toBeInTheDocument();
  });

  it("rechaza un correo con formato inválido", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(await screen.findByLabelText("Correo electrónico"), "no-es-un-correo");
    await user.type(screen.getByLabelText("Contraseña"), "12345678");
    await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    expect(await screen.findByText("Ingresa un correo electrónico válido.")).toBeInTheDocument();
  });

  it("muestra el mensaje real del error cuando la API rechaza las credenciales", async () => {
    const { server, http, HttpResponse } = await import("@/test/msw");
    server.use(
      http.post("*/auth/login", () =>
        HttpResponse.json(
          { type: "https://atiende.example/errors/unauthorized", title: "Credenciales inválidas", status: 401, requestId: "req-1" },
          { status: 401 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(await screen.findByLabelText("Correo electrónico"), "persona@empresa.com");
    await user.type(screen.getByLabelText("Contraseña"), "12345678");
    await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    expect(await screen.findByText(/Credenciales inválidas/)).toBeInTheDocument();
    expect(screen.getByText(/req-1/)).toBeInTheDocument();
  });

  it("no tiene violaciones de accesibilidad detectables por axe", async () => {
    renderWithProviders(<LoginPage />);
    await screen.findByRole("main");
    // axe(document.body), no axe(container) (W-13): LoginPage es la única
    // pantalla sin <AppShell/>, así que sus reglas de nivel de documento
    // (landmark-one-main, page-has-heading-one, region — W-08) solo son
    // visibles corriendo sobre el documento completo, no sobre el subárbol
    // que monta Testing Library.
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  }, 15000);
});
