import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import RestablecerPasswordPage from "@/pages/auth/RestablecerPasswordPage";

const ENLACE = "/restablecer-contrasena?d=payload-firmado&s=firma-hmac";

/**
 * El mismo 400 genérico con el que `apps/api` responde a CUALQUIER enlace
 * que no sirve (vencido, ya usado, firma alterada, cuenta borrada): un
 * único mensaje, sin distinguir el motivo — ver
 * apps/api/src/modules/auth/mail.routes.ts, `invalidLinkError()`.
 */
const ENLACE_INVALIDO = {
  type: "https://atiende.example/errors/bad-request",
  title: "El enlace no es válido o ya venció. Solicita uno nuevo.",
  status: 400,
  requestId: "req-400",
};

function renderConRutas(ruta: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/restablecer-contrasena" element={<RestablecerPasswordPage />} />
      <Route path="/login" element={<p>pantalla de acceso</p>} />
      <Route path="/recuperar-contrasena" element={<p>pantalla de recuperación</p>} />
    </Routes>,
    { route: ruta },
  );
}

describe("RestablecerPasswordPage (REQ-186)", () => {
  it("manda d/s tal cual llegaron + la contraseña nueva y termina en /login", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.post("*/auth/password/reset", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );

    renderConRutas(ENLACE);
    await user.type(screen.getByLabelText("Contraseña nueva"), "ContraseñaNueva123");
    await user.type(screen.getByLabelText("Repite la contraseña nueva"), "ContraseñaNueva123");
    await user.click(screen.getByRole("button", { name: "Guardar contraseña nueva" }));

    // Redirige a /login en vez de abrir sesión sola: apps/api revoca TODAS
    // las sesiones en la misma transacción que cambia la contraseña.
    expect(await screen.findByText("pantalla de acceso")).toBeInTheDocument();
    expect(bodies).toEqual([{ d: "payload-firmado", s: "firma-hmac", newPassword: "ContraseñaNueva123" }]);
  });

  /**
   * ADVERSARIAL (token vencido / reutilizado). Los dos casos dan el MISMO
   * 400 en la API, así que la pantalla no puede afirmar cuál fue: enumera
   * los motivos posibles y ofrece pedir un enlace nuevo.
   */
  it("ante el 400 de enlace vencido o ya usado enumera los motivos y ofrece pedir uno nuevo", async () => {
    const user = userEvent.setup();
    server.use(http.post("*/auth/password/reset", () => HttpResponse.json(ENLACE_INVALIDO, { status: 400 })));

    renderConRutas(ENLACE);
    await user.type(screen.getByLabelText("Contraseña nueva"), "ContraseñaNueva123");
    await user.type(screen.getByLabelText("Repite la contraseña nueva"), "ContraseñaNueva123");
    await user.click(screen.getByRole("button", { name: "Guardar contraseña nueva" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Este enlace ya no sirve" })).toBeInTheDocument();
    expect(screen.getByText(/Ya venció: los enlaces de restablecimiento viven 30 minutos\./)).toBeInTheDocument();
    expect(screen.getByText(/Ya se usó: cada enlace sirve una sola vez/)).toBeInTheDocument();
    expect(screen.getByText(/request_id: req-400/)).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Pedir un enlace nuevo" }));
    expect(await screen.findByText("pantalla de recuperación")).toBeInTheDocument();
  });

  /**
   * ADVERSARIAL (enlace truncado). Un cliente de correo que parte la URL
   * deja `?d=` sin `s=`. No se manda a la API una petición que ya se sabe
   * incompleta: se explica y se ofrece pedir otro enlace.
   */
  it("con el enlace incompleto (falta `s`) ni siquiera llama a la API", async () => {
    let llamadas = 0;
    server.use(
      http.post("*/auth/password/reset", () => {
        llamadas += 1;
        return HttpResponse.json({ ok: true });
      }),
    );

    renderConRutas("/restablecer-contrasena?d=payload-sin-firma");

    expect(await screen.findByRole("heading", { level: 1, name: "Este enlace llegó incompleto" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Contraseña nueva")).not.toBeInTheDocument();
    expect(llamadas).toBe(0);
  });

  it("no manda nada si las dos contraseñas no coinciden", async () => {
    const user = userEvent.setup();
    let llamadas = 0;
    server.use(
      http.post("*/auth/password/reset", () => {
        llamadas += 1;
        return HttpResponse.json({ ok: true });
      }),
    );

    renderConRutas(ENLACE);
    await user.type(screen.getByLabelText("Contraseña nueva"), "ContraseñaNueva123");
    await user.type(screen.getByLabelText("Repite la contraseña nueva"), "OtraDistinta123");
    await user.click(screen.getByRole("button", { name: "Guardar contraseña nueva" }));

    expect(await screen.findByText("Las dos contraseñas no coinciden.")).toBeInTheDocument();
    expect(llamadas).toBe(0);
  });

  it("exige el mínimo REAL de la API (8 caracteres), ni más ni menos", async () => {
    const user = userEvent.setup();
    renderConRutas(ENLACE);
    await user.type(screen.getByLabelText("Contraseña nueva"), "corta12");
    await user.type(screen.getByLabelText("Repite la contraseña nueva"), "corta12");
    await user.click(screen.getByRole("button", { name: "Guardar contraseña nueva" }));

    expect(await screen.findByText("La contraseña debe tener al menos 8 caracteres.")).toBeInTheDocument();
  });

  /**
   * Un 500 NO es un enlace inválido: el formulario tiene que seguir ahí
   * para reintentar con el mismo enlace, que puede seguir siendo bueno.
   */
  it("un error de servidor deja el formulario disponible en vez de declarar el enlace muerto", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/auth/password/reset", () =>
        HttpResponse.json({ title: "Error interno del servidor", status: 500, requestId: "req-500" }, { status: 500 }),
      ),
    );

    renderConRutas(ENLACE);
    await user.type(screen.getByLabelText("Contraseña nueva"), "ContraseñaNueva123");
    await user.type(screen.getByLabelText("Repite la contraseña nueva"), "ContraseñaNueva123");
    await user.click(screen.getByRole("button", { name: "Guardar contraseña nueva" }));

    expect(await screen.findByText(/request_id: req-500/)).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña nueva")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Este enlace ya no sirve" })).not.toBeInTheDocument();
  });

  it("no tiene violaciones de accesibilidad detectables por axe", async () => {
    renderConRutas(ENLACE);
    await screen.findByRole("main");
    expect(await axe(document.body)).toHaveNoViolations();
  }, 15000);
});
