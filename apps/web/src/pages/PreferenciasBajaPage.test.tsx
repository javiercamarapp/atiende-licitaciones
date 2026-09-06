import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import PreferenciasBajaPage from "@/pages/PreferenciasBajaPage";

const ENLACE = "/preferencias/baja?d=payload-firmado&s=firma-hmac";

function renderConRutas(ruta: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/preferencias/baja" element={<PreferenciasBajaPage />} />
      <Route path="/unsubscribe" element={<PreferenciasBajaPage />} />
      <Route path="/configuracion" element={<p>pantalla de configuración</p>} />
    </Routes>,
    { route: ruta },
  );
}

describe("PreferenciasBajaPage (REQ-187, RFC 8058)", () => {
  /**
   * La regla central de esta pantalla: abrir el enlace VALIDA (GET) pero no
   * da de baja a nadie. La baja la aplica un POST explícito. Sin esto, un
   * escáner de enlaces del propio proveedor de correo apagaría avisos que
   * el usuario nunca pidió apagar.
   */
  it("al abrir el enlace solo valida (GET); la baja la aplica el clic (POST)", async () => {
    const user = userEvent.setup();
    let gets = 0;
    let posts = 0;
    server.use(
      http.get("*/mail/unsubscribe", () => {
        gets += 1;
        return HttpResponse.json({ valid: true, category: "weekly_summary" });
      }),
      http.post("*/mail/unsubscribe", () => {
        posts += 1;
        return HttpResponse.json({ ok: true });
      }),
    );

    renderConRutas(ENLACE);

    expect(await screen.findByRole("heading", { level: 1, name: "¿Confirmas la baja?" })).toBeInTheDocument();
    expect(gets).toBe(1);
    expect(posts).toBe(0);

    await user.click(screen.getByRole("button", { name: "Sí, darme de baja" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Listo, dejarás de recibir esos avisos" })).toBeInTheDocument();
    expect(posts).toBe(1);
  });

  it("traduce la categoría real que devuelve la API y manda d/s tal cual en la query", async () => {
    const urls: string[] = [];
    server.use(
      http.get("*/mail/unsubscribe", ({ request }) => {
        urls.push(new URL(request.url).search);
        return HttpResponse.json({ valid: true, category: "document_expiration" });
      }),
    );

    renderConRutas(ENLACE);

    expect(await screen.findByText(/Vencimiento de documentos de la empresa/)).toBeInTheDocument();
    expect(urls).toEqual(["?d=payload-firmado&s=firma-hmac"]);
  });

  it("un enlace sin categoría (null) apaga TODAS las opcionales y lo dice", async () => {
    server.use(http.get("*/mail/unsubscribe", () => HttpResponse.json({ valid: true, category: null })));

    renderConRutas(ENLACE);

    expect(await screen.findByText(/Vas a apagar TODAS las categorías opcionales/)).toBeInTheDocument();
  });

  /**
   * REQ-187: la pantalla está obligada a decir que los correos de seguridad
   * de la cuenta NO son apagables (no están en `OPTIONAL_CATEGORIES` de
   * apps/api). Ocultarlo generaría la queja legítima de "me di de baja y me
   * siguen llegando correos".
   */
  it("dice, antes y después de la baja, que los correos de seguridad no se pueden desactivar", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/mail/unsubscribe", () => HttpResponse.json({ valid: true, category: "approvals" })),
      http.post("*/mail/unsubscribe", () => HttpResponse.json({ ok: true })),
    );

    renderConRutas(ENLACE);
    expect(await screen.findByText(/Los correos de seguridad de la cuenta seguirán llegando/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sí, darme de baja" }));
    await screen.findByRole("heading", { level: 1, name: "Listo, dejarás de recibir esos avisos" });
    expect(screen.getByText(/Los correos de seguridad de la cuenta seguirán llegando/)).toBeInTheDocument();
  });

  /**
   * ADVERSARIAL (enlace inválido/vencido/categoría desconocida): la API da
   * un ÚNICO 400 para los tres. La pantalla no inventa cuál fue y ofrece la
   * alternativa real (las preferencias con sesión).
   */
  it("ante el 400 del enlace no finge una baja y manda a las preferencias con sesión", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/mail/unsubscribe", () =>
        HttpResponse.json({ title: "El enlace de baja no es válido o ya venció.", status: 400, requestId: "req-400" }, { status: 400 }),
      ),
    );

    renderConRutas(ENLACE);

    expect(await screen.findByRole("heading", { level: 1, name: "Este enlace de baja ya no sirve" })).toBeInTheDocument();
    expect(screen.getByText(/request_id: req-400/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sí, darme de baja" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Abrir mis preferencias de notificación" }));
    expect(await screen.findByText("pantalla de configuración")).toBeInTheDocument();
  });

  it("con el enlace incompleto no llama a la API", async () => {
    let llamadas = 0;
    server.use(
      http.get("*/mail/unsubscribe", () => {
        llamadas += 1;
        return HttpResponse.json({ valid: true, category: null });
      }),
    );

    renderConRutas("/preferencias/baja?d=solo-el-payload");

    expect(await screen.findByRole("heading", { level: 1, name: "Este enlace llegó incompleto" })).toBeInTheDocument();
    expect(llamadas).toBe(0);
  });

  it("el alias /unsubscribe es la MISMA pantalla", async () => {
    server.use(http.get("*/mail/unsubscribe", () => HttpResponse.json({ valid: true, category: "deadlines" })));

    renderConRutas("/unsubscribe?d=payload-firmado&s=firma-hmac");

    expect(await screen.findByRole("heading", { level: 1, name: "¿Confirmas la baja?" })).toBeInTheDocument();
    expect(screen.getByText(/Plazos próximos a vencer/)).toBeInTheDocument();
  });

  it("no tiene violaciones de accesibilidad detectables por axe", async () => {
    server.use(http.get("*/mail/unsubscribe", () => HttpResponse.json({ valid: true, category: "weekly_summary" })));
    renderConRutas(ENLACE);
    await screen.findByRole("heading", { level: 1, name: "¿Confirmas la baja?" });
    expect(await axe(document.body)).toHaveNoViolations();
  }, 15000);
});
