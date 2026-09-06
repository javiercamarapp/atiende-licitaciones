import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { problemJson, mockGoogleStart, mockSessionHydration } from "@/test/googleAuthMocks";
import RegistroPage from "@/pages/RegistroPage";

function renderRegistro() {
  return renderWithProviders(
    <Routes>
      <Route path="/registro" element={<RegistroPage />} />
      <Route path="/panel" element={<p>Panel real</p>} />
      <Route path="/sin-acceso" element={<p>Pantalla sin acceso</p>} />
    </Routes>,
    { route: "/registro" },
  );
}

describe("RegistroPage (REQ-172)", () => {
  it("ofrece los DOS métodos reales de alta en la misma pantalla", async () => {
    renderRegistro();
    expect(await screen.findByRole("heading", { level: 1, name: "Crea tu cuenta de Atiende Licitaciones" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crear cuenta" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Registrarme con Google" })).toBeEnabled();
  });

  it("valida con zod antes de enviar: correo inválido y contraseña corta no llegan a la API", async () => {
    const user = userEvent.setup();
    renderRegistro();

    await user.type(screen.getByLabelText("Correo electrónico"), "no-es-un-correo");
    await user.type(screen.getByLabelText("Contraseña"), "corta");
    await user.type(screen.getByLabelText("Repite la contraseña"), "corta");
    await user.click(screen.getByRole("button", { name: "Crear cuenta" }));

    expect(await screen.findByText("Ingresa un correo electrónico válido.")).toBeInTheDocument();
    expect(screen.getByText("La contraseña debe tener al menos 8 caracteres.")).toBeInTheDocument();
  });

  it("adversarial: si las dos contraseñas no coinciden no se crea nada (protección solo del cliente, apps/api no la recibe)", async () => {
    const user = userEvent.setup();
    renderRegistro();

    await user.type(screen.getByLabelText("Correo electrónico"), "persona@empresa.com");
    await user.type(screen.getByLabelText("Contraseña"), "ContraseñaSegura123");
    await user.type(screen.getByLabelText("Repite la contraseña"), "ContraseñaDistinta123");
    await user.click(screen.getByRole("button", { name: "Crear cuenta" }));

    expect(await screen.findByText("Las dos contraseñas no coinciden.")).toBeInTheDocument();
  });

  it("alta real: POST /auth/register + login encadenado deja la sesión abierta", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/auth/register", () => HttpResponse.json({ id: "user-1", email: "persona@empresa.com" }, { status: 201 })),
      http.post("*/auth/login", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
      ...mockSessionHydration({ memberships: [{ id: "org-1", name: "Org", slug: "org", role: "owner" }] }),
    );

    renderRegistro();
    await user.type(screen.getByLabelText("Nombre completo (opcional)"), "Ana Pérez");
    await user.type(screen.getByLabelText("Correo electrónico"), "persona@empresa.com");
    await user.type(screen.getByLabelText("Contraseña"), "ContraseñaSegura123");
    await user.type(screen.getByLabelText("Repite la contraseña"), "ContraseñaSegura123");
    await user.click(screen.getByRole("button", { name: "Crear cuenta" }));

    // Con sesión ya activa, la propia pantalla redirige (mismo criterio que
    // LoginPage) — es la señal observable de que el login encadenado
    // realmente ocurrió, no solo el POST /auth/register.
    expect(await screen.findByText("Panel real")).toBeInTheDocument();
  });

  it("API-03 adversarial: un correo YA registrado responde 201 igual (antienumeración), pero el login encadenado falla con el motivo real", async () => {
    const user = userEvent.setup();
    server.use(
      // apps/api devuelve el MISMO 201 que un alta nueva: nunca confirma
      // que el correo ya existía (docs/auditoria-1/db-api.md, API-03).
      http.post("*/auth/register", () => HttpResponse.json({ id: "otro-id", email: "persona@empresa.com" }, { status: 201 })),
      http.post("*/auth/login", () => problemJson({ status: 401, title: "Credenciales inválidas." })),
    );

    renderRegistro();
    await user.type(screen.getByLabelText("Correo electrónico"), "persona@empresa.com");
    await user.type(screen.getByLabelText("Contraseña"), "ContraseñaSegura123");
    await user.type(screen.getByLabelText("Repite la contraseña"), "ContraseñaSegura123");
    await user.click(screen.getByRole("button", { name: "Crear cuenta" }));

    expect(await screen.findByText(/Credenciales inválidas/)).toBeInTheDocument();
    expect(screen.queryByText("Panel real")).not.toBeInTheDocument();
  });

  // No se prueba aquí el 429 del límite de tasa a propósito: `rawRequest`
  // (src/lib/api/http.ts) lo REINTENTA con backoff respetando `Retry-After`
  // antes de propagarlo, así que un handler que responde 429 siempre no
  // ejercita esta pantalla sino ese reintento — ya cubierto por
  // src/lib/api/client.test.ts. Un 500 sí llega directo al formulario.
  it("adversarial: un fallo del servidor se muestra tal cual, sin inventar que la cuenta se creó", async () => {
    const user = userEvent.setup();
    server.use(http.post("*/auth/register", () => problemJson({ status: 500, title: "Error interno del servidor." })));

    renderRegistro();
    await user.type(screen.getByLabelText("Correo electrónico"), "persona@empresa.com");
    await user.type(screen.getByLabelText("Contraseña"), "ContraseñaSegura123");
    await user.type(screen.getByLabelText("Repite la contraseña"), "ContraseñaSegura123");
    await user.click(screen.getByRole("button", { name: "Crear cuenta" }));

    expect(await screen.findByText(/Error interno del servidor/)).toBeInTheDocument();
    expect(screen.queryByText("Panel real")).not.toBeInTheDocument();
  });

  it("REQ-178: el 503 de Google también deshabilita el alta con Google aquí, sin afectar al alta por contraseña", async () => {
    const user = userEvent.setup();
    server.use(mockGoogleStart({ status: 503, title: "Login con Google no configurado." }));

    renderRegistro();
    const googleButton = screen.getByRole("button", { name: "Registrarme con Google" });
    await user.click(googleButton);

    expect(await screen.findByText(/Login con Google no configurado/)).toBeInTheDocument();
    expect(googleButton).toBeDisabled();
    // El otro método sigue disponible: un Google mal configurado nunca deja
    // la pantalla de registro sin salida.
    expect(screen.getByRole("button", { name: "Crear cuenta" })).toBeEnabled();
  });
});
