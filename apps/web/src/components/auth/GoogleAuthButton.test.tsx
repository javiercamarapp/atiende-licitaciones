import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server } from "@/test/msw";
import { mockGoogleStart } from "@/test/googleAuthMocks";
import { GoogleAuthButton } from "@/components/auth/GoogleAuthButton";

// jsdom no permite `vi.spyOn(window.location, "assign")` directo
// (`Cannot redefine property: assign`, la propiedad no es configurable) —
// se reemplaza `window.location` completo por un doble con la misma forma
// y se restaura al terminar cada prueba.
let assignMock: ReturnType<typeof vi.fn>;
let originalLocation: Location;

beforeEach(() => {
  assignMock = vi.fn();
  originalLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign: assignMock },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("GoogleAuthButton (REQ-172/178)", () => {
  it("al hacer clic pide GET /auth/google/start y navega el navegador completo a authorizationUrl", async () => {
    server.use(mockGoogleStart({ authorizationUrl: "https://provider.example.test/authorize?state=abc" }));

    const user = userEvent.setup();
    renderWithProviders(<GoogleAuthButton />);

    await user.click(screen.getByRole("button", { name: "Continuar con Google" }));

    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("https://provider.example.test/authorize?state=abc"));
  });

  it("REQ-178: un 503 (Google no configurado) deshabilita el botón y muestra el mensaje real del servidor, sin navegar", async () => {
    server.use(
      mockGoogleStart({
        status: 503,
        title: "Login con Google no configurado: faltan GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI.",
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<GoogleAuthButton />);

    const button = screen.getByRole("button", { name: "Continuar con Google" });
    await user.click(button);

    expect(await screen.findByText(/Login con Google no configurado/)).toBeInTheDocument();
    await waitFor(() => expect(button).toBeDisabled());
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("un error inesperado (p. ej. 500) deja el botón habilitado con un mensaje honesto", async () => {
    server.use(mockGoogleStart({ status: 500, title: "Error interno del servidor" }));

    const user = userEvent.setup();
    renderWithProviders(<GoogleAuthButton />);

    const button = screen.getByRole("button", { name: "Continuar con Google" });
    await user.click(button);

    expect(await screen.findByText(/Error interno del servidor/)).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });
});
