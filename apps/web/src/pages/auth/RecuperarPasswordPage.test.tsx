import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import RecuperarPasswordPage from "@/pages/auth/RecuperarPasswordPage";

const MENSAJE_UNICO = /Si existe una cuenta con ese correo/;

describe("RecuperarPasswordPage (REQ-186)", () => {
  it("manda el correo a POST /auth/password/forgot y muestra el mensaje que no revela nada", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.post("*/auth/password/forgot", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true }, { status: 202 });
      }),
    );

    renderWithProviders(<RecuperarPasswordPage />);
    await user.type(screen.getByLabelText("Correo electrónico"), "ana@empresa.com");
    await user.click(screen.getByRole("button", { name: "Enviarme el enlace" }));

    expect(await screen.findByText(MENSAJE_UNICO)).toBeInTheDocument();
    expect(bodies).toEqual([{ email: "ana@empresa.com" }]);
  });

  /**
   * ADVERSARIAL (enumeración de cuentas). `apps/api` responde 202 con el
   * MISMO cuerpo exista o no la dirección; si esta pantalla dijera algo
   * distinto en cada caso, esa defensa del servidor no serviría de nada.
   * La prueba compara el HTML renderizado de los dos casos: tiene que ser
   * IDÉNTICO, no "parecido".
   */
  it("no distingue una cuenta que existe de una que no: el mismo texto exacto en los dos casos", async () => {
    server.use(http.post("*/auth/password/forgot", () => HttpResponse.json({ ok: true }, { status: 202 })));

    const enviarY = async (email: string) => {
      const user = userEvent.setup();
      const { unmount } = renderWithProviders(<RecuperarPasswordPage />);
      await user.type(screen.getByLabelText("Correo electrónico"), email);
      await user.click(screen.getByRole("button", { name: "Enviarme el enlace" }));
      const aviso = await screen.findByRole("status");
      const html = aviso.innerHTML;
      unmount();
      return html;
    };

    const existente = await enviarY("registrada@empresa.com");
    const inexistente = await enviarY("no-existe@empresa.com");
    expect(existente).toBe(inexistente);
  });

  /**
   * ADVERSARIAL (429). El endpoint está en el tier `auth` (5/min por IP) y
   * el cliente NO reintenta a espaldas del usuario (`retries = 0`, ver
   * lib/api/mail.ts): mandar el correo igual 20s después vaciaría de
   * sentido ese límite. La pantalla muestra el mensaje propio en español,
   * nunca el literal en inglés de @fastify/rate-limit.
   */
  it("muestra un 429 claro y NO reintenta por su cuenta", async () => {
    const user = userEvent.setup();
    let intentos = 0;
    server.use(
      http.post("*/auth/password/forgot", () => {
        intentos += 1;
        return HttpResponse.json(
          { type: "…/bad-request", title: "Rate limit exceeded, retry in 1 minute", status: 429, requestId: "req-429" },
          { status: 429, headers: { "retry-after": "60" } },
        );
      }),
    );

    renderWithProviders(<RecuperarPasswordPage />);
    await user.type(screen.getByLabelText("Correo electrónico"), "ana@empresa.com");
    await user.click(screen.getByRole("button", { name: "Enviarme el enlace" }));

    expect(await screen.findByText(/Demasiados intentos desde esta conexión/)).toBeInTheDocument();
    expect(screen.queryByText(/Rate limit exceeded/)).not.toBeInTheDocument();
    expect(intentos).toBe(1);
    expect(screen.queryByText(MENSAJE_UNICO)).not.toBeInTheDocument();
  });

  it("muestra el error real de la API (con request_id) y no finge éxito", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/auth/password/forgot", () =>
        HttpResponse.json({ title: "Error interno del servidor", status: 500, requestId: "req-77" }, { status: 500 }),
      ),
    );

    renderWithProviders(<RecuperarPasswordPage />);
    await user.type(screen.getByLabelText("Correo electrónico"), "ana@empresa.com");
    await user.click(screen.getByRole("button", { name: "Enviarme el enlace" }));

    expect(await screen.findByText(/request_id: req-77/)).toBeInTheDocument();
    expect(screen.queryByText(MENSAJE_UNICO)).not.toBeInTheDocument();
  });

  it("valida el correo en el cliente antes de gastar una petición del límite de tasa", async () => {
    const user = userEvent.setup();
    const llamado = vi.fn();
    server.use(
      http.post("*/auth/password/forgot", () => {
        llamado();
        return HttpResponse.json({ ok: true }, { status: 202 });
      }),
    );

    renderWithProviders(<RecuperarPasswordPage />);
    await user.type(screen.getByLabelText("Correo electrónico"), "no-es-un-correo");
    await user.click(screen.getByRole("button", { name: "Enviarme el enlace" }));

    expect(await screen.findByText("Ingresa un correo electrónico válido.")).toBeInTheDocument();
    expect(llamado).not.toHaveBeenCalled();
  });

  it("no tiene violaciones de accesibilidad detectables por axe", async () => {
    renderWithProviders(<RecuperarPasswordPage />);
    await screen.findByRole("main");
    expect(await axe(document.body)).toHaveNoViolations();
  }, 15000);
});
