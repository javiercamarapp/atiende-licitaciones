import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { axe } from "vitest-axe";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/hooks/useAuth";
import { server, http, HttpResponse } from "@/test/msw";
import RevisaTuCorreoPage, { type RevisaTuCorreoState } from "@/pages/auth/RevisaTuCorreoPage";

/**
 * `renderWithProviders` no permite fijar el `state` de la navegación, y
 * ese `state` es justo lo que distingue las dos puertas de esta pantalla
 * (registro vs. compuerta del login) — y también el motivo por el que el
 * correo NO viaja en la query. De ahí este render propio con
 * `initialEntries: [{ pathname, state }]`.
 */
function renderConEstado(state: RevisaTuCorreoState | undefined) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[{ pathname: "/revisa-tu-correo", state }]}>
          <AuthProvider>
            <Routes>
              <Route path="/revisa-tu-correo" element={<RevisaTuCorreoPage />} />
              <Route path="/login" element={<p>pantalla de acceso</p>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("RevisaTuCorreoPage (REQ-181)", () => {
  it("tras el registro avisa de la confirmación sin afirmar que la cuenta se creó", async () => {
    renderConEstado({ email: "ana@empresa.com", motivo: "registro" });

    expect(await screen.findByRole("heading", { level: 1, name: "Revisa tu correo" })).toBeInTheDocument();
    expect(screen.getByText("ana@empresa.com")).toBeInTheDocument();
    // API-03: `POST /auth/register` responde 201 exista o no ya el correo,
    // así que esta pantalla NUNCA puede decir "cuenta creada".
    expect(screen.queryByText(/cuenta creada/i)).not.toBeInTheDocument();
  });

  it("desde la compuerta del login explica que la contraseña sí era correcta", async () => {
    renderConEstado({ email: "ana@empresa.com", motivo: "login" });

    expect(await screen.findByRole("heading", { level: 1, name: "Confirma tu correo para entrar" })).toBeInTheDocument();
    expect(screen.getByText(/Tu contraseña es correcta/)).toBeInTheDocument();
  });

  /**
   * Al recargar se pierde el `state` (es el precio de NO poner el correo en
   * la query, donde acabaría en el historial y en el `Referer`). La
   * pantalla tiene que seguir siendo utilizable: el formulario de reenvío
   * aparece vacío, no roto.
   */
  it("sin `state` (recarga directa) sigue ofreciendo el reenvío con el campo vacío", async () => {
    renderConEstado(undefined);

    expect(await screen.findByRole("heading", { level: 1, name: "Revisa tu correo" })).toBeInTheDocument();
    expect(screen.getByLabelText("Correo de tu cuenta")).toHaveValue("");
    expect(screen.getByText(/Si no recuerdas con qué correo te registraste/)).toBeInTheDocument();
  });

  it("reenvía el enlace con el correo prellenado del estado", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.post("*/auth/email/resend-verification", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true }, { status: 202 });
      }),
    );

    renderConEstado({ email: "ana@empresa.com", motivo: "login" });
    await user.click(await screen.findByRole("button", { name: "Reenviar enlace de confirmación" }));

    expect(await screen.findByText(/Si esa cuenta existe y aún no está confirmada/)).toBeInTheDocument();
    expect(bodies).toEqual([{ email: "ana@empresa.com" }]);
  });

  it("no tiene violaciones de accesibilidad detectables por axe", async () => {
    renderConEstado({ email: "ana@empresa.com", motivo: "registro" });
    await screen.findByRole("main");
    expect(await axe(document.body)).toHaveNoViolations();
  }, 15000);
});
