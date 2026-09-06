import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { Route, Routes } from "react-router-dom";

import { renderWithProviders } from "@/test/utils";
import LoginPage from "@/pages/LoginPage";

describe("LoginPage", () => {
  it("tiene un landmark <main> y un <h1> real (W-08)", async () => {
    renderWithProviders(<LoginPage />);
    expect(await screen.findByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Accede a tu panel de licitaciones" })).toBeInTheDocument();
  });

  it("REQ-172: ambos métodos de acceso (contraseña y Google) están visibles y funcionales en la misma pantalla", async () => {
    renderWithProviders(<LoginPage />);
    expect(await screen.findByRole("button", { name: "Iniciar sesión" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Continuar con Google" })).toBeEnabled();
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

  it("ofrece el camino de recuperación de contraseña (ronda 8b)", async () => {
    renderWithProviders(<LoginPage />);
    expect(await screen.findByRole("link", { name: "¿Olvidaste tu contraseña?" })).toHaveAttribute(
      "href",
      "/recuperar-contrasena",
    );
  });

  /**
   * REQ-181 (ronda 8b): la compuerta de verificación de correo responde un
   * `403 email-not-verified` DESPUÉS de validar la contraseña. Es un error
   * distinto del 401 de credenciales y merece un camino distinto: la
   * pantalla de "confirma tu correo", con reenvío — nunca un mensaje rojo
   * que diría algo falso sobre la contraseña.
   */
  it("un 403 `email-not-verified` lleva a la pantalla de confirmación, no a un error de credenciales", async () => {
    const { server, http, HttpResponse } = await import("@/test/msw");
    server.use(
      http.post("*/auth/login", () =>
        HttpResponse.json(
          {
            type: "https://atiende.example/errors/email-not-verified",
            title: "Confirma tu correo antes de iniciar sesión. Te podemos reenviar el enlace de confirmación.",
            status: 403,
            requestId: "req-403",
          },
          { status: 403 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/revisa-tu-correo" element={<p>pantalla de confirmación de correo</p>} />
      </Routes>,
      { route: "/login" },
    );

    await user.type(await screen.findByLabelText("Correo electrónico"), "persona@empresa.com");
    await user.type(screen.getByLabelText("Contraseña"), "12345678");
    await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    expect(await screen.findByText("pantalla de confirmación de correo")).toBeInTheDocument();
  });

  /**
   * ADVERSARIAL: un 403 que NO es el de la compuerta (p. ej. el de una
   * organización sin acceso) no debe mandar al usuario a confirmar un
   * correo que ya está confirmado — por eso se comprueba el `type`, no
   * solo el código.
   */
  it("otro 403 cualquiera se muestra como error, sin desviar a la confirmación de correo", async () => {
    const { server, http, HttpResponse } = await import("@/test/msw");
    server.use(
      http.post("*/auth/login", () =>
        HttpResponse.json(
          { type: "https://atiende.example/errors/forbidden", title: "Sin permiso", status: 403, requestId: "req-otro" },
          { status: 403 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/revisa-tu-correo" element={<p>pantalla de confirmación de correo</p>} />
      </Routes>,
      { route: "/login" },
    );

    await user.type(await screen.findByLabelText("Correo electrónico"), "persona@empresa.com");
    await user.type(screen.getByLabelText("Contraseña"), "12345678");
    await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    expect(await screen.findByText(/Sin permiso/)).toBeInTheDocument();
    expect(screen.queryByText("pantalla de confirmación de correo")).not.toBeInTheDocument();
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
