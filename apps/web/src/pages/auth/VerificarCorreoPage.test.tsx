import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import VerificarCorreoPage from "@/pages/auth/VerificarCorreoPage";

const ENLACE = "/verificar-correo?d=payload-firmado&s=firma-hmac";

const ENLACE_INVALIDO = {
  type: "https://atiende.example/errors/bad-request",
  title: "El enlace no es válido o ya venció. Solicita uno nuevo.",
  status: 400,
  requestId: "req-400",
};

function renderConRutas(ruta: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/verificar-correo" element={<VerificarCorreoPage />} />
      <Route path="/login" element={<p>pantalla de acceso</p>} />
    </Routes>,
    { route: ruta },
  );
}

describe("VerificarCorreoPage (REQ-181)", () => {
  it("consume el enlace en cuanto se monta y confirma el correo", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post("*/auth/email/verify", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ verified: true });
      }),
    );

    renderConRutas(ENLACE);

    expect(await screen.findByRole("heading", { level: 1, name: "Listo, tu correo quedó confirmado" })).toBeInTheDocument();
    // Los parámetros del enlace se reenvían TAL CUAL: esta capa no los
    // interpreta ni los reconstruye.
    expect(bodies).toEqual([{ d: "payload-firmado", s: "firma-hmac" }]);
  });

  it("llama a la API UNA sola vez aunque el componente se vuelva a renderizar", async () => {
    let llamadas = 0;
    server.use(
      http.post("*/auth/email/verify", () => {
        llamadas += 1;
        return HttpResponse.json({ verified: true });
      }),
    );

    const { rerender } = renderConRutas(ENLACE);
    await screen.findByRole("heading", { level: 1, name: "Listo, tu correo quedó confirmado" });
    rerender(
      <Routes>
        <Route path="/verificar-correo" element={<VerificarCorreoPage />} />
      </Routes>,
    );

    expect(llamadas).toBe(1);
  });

  /**
   * ADVERSARIAL (token reutilizado o vencido). La API responde el MISMO 400
   * en los cuatro casos posibles, así que la pantalla enumera los motivos y
   * ofrece la única salida real: reenviar el enlace.
   */
  it("ante un enlace ya usado o vencido enumera los motivos y ofrece el reenvío", async () => {
    server.use(http.post("*/auth/email/verify", () => HttpResponse.json(ENLACE_INVALIDO, { status: 400 })));

    renderConRutas(ENLACE);

    expect(await screen.findByRole("heading", { level: 1, name: "Este enlace ya no sirve" })).toBeInTheDocument();
    expect(screen.getByText(/Ya se usó: cada enlace sirve una sola vez/)).toBeInTheDocument();
    expect(screen.getByText(/request_id: req-400/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reenviar enlace de confirmación" })).toBeInTheDocument();
  });

  it("con el enlace incompleto no llama a la API y ofrece el reenvío igual", async () => {
    let llamadas = 0;
    server.use(
      http.post("*/auth/email/verify", () => {
        llamadas += 1;
        return HttpResponse.json({ verified: true });
      }),
    );

    renderConRutas("/verificar-correo?d=solo-el-payload");

    expect(await screen.findByRole("heading", { level: 1, name: "Este enlace llegó incompleto" })).toBeInTheDocument();
    expect(llamadas).toBe(0);
    expect(screen.getByRole("button", { name: "Reenviar enlace de confirmación" })).toBeInTheDocument();
  });

  it("reenvía la confirmación con el mismo mensaje que no revela si la cuenta existe", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.post("*/auth/email/verify", () => HttpResponse.json(ENLACE_INVALIDO, { status: 400 })),
      http.post("*/auth/email/resend-verification", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true }, { status: 202 });
      }),
    );

    renderConRutas(ENLACE);
    await screen.findByRole("heading", { level: 1, name: "Este enlace ya no sirve" });
    await user.type(screen.getByLabelText("Correo de tu cuenta"), "ana@empresa.com");
    await user.click(screen.getByRole("button", { name: "Reenviar enlace de confirmación" }));

    expect(await screen.findByText(/Si esa cuenta existe y aún no está confirmada/)).toBeInTheDocument();
    expect(bodies).toEqual([{ email: "ana@empresa.com" }]);
  });

  /**
   * ADVERSARIAL (429 en el reenvío). Mismo tier `auth` que el login: el
   * cliente no reintenta solo, y la pantalla no dice "ya va en camino"
   * cuando el servidor rechazó la petición.
   */
  it("muestra un 429 claro en el reenvío y NO reintenta ni finge éxito", async () => {
    const user = userEvent.setup();
    let intentos = 0;
    server.use(
      http.post("*/auth/email/verify", () => HttpResponse.json(ENLACE_INVALIDO, { status: 400 })),
      http.post("*/auth/email/resend-verification", () => {
        intentos += 1;
        return HttpResponse.json({ title: "Rate limit exceeded, retry in 1 minute", status: 429 }, { status: 429 });
      }),
    );

    renderConRutas(ENLACE);
    await screen.findByRole("heading", { level: 1, name: "Este enlace ya no sirve" });
    await user.type(screen.getByLabelText("Correo de tu cuenta"), "ana@empresa.com");
    await user.click(screen.getByRole("button", { name: "Reenviar enlace de confirmación" }));

    expect(await screen.findByText(/Demasiados intentos desde esta conexión/)).toBeInTheDocument();
    expect(intentos).toBe(1);
    expect(screen.queryByText(/Si esa cuenta existe y aún no está confirmada/)).not.toBeInTheDocument();
  });

  it("no tiene violaciones de accesibilidad detectables por axe", async () => {
    server.use(http.post("*/auth/email/verify", () => HttpResponse.json({ verified: true })));
    renderConRutas(ENLACE);
    await screen.findByRole("heading", { level: 1, name: "Listo, tu correo quedó confirmado" });
    expect(await axe(document.body)).toHaveNoViolations();
  }, 15000);
});
