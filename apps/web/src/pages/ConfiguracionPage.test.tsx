import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QRCode from "qrcode";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import { Toaster } from "@/components/ui/sonner";
import ConfiguracionPage from "@/pages/ConfiguracionPage";

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    // Ronda 8b: la tarjeta de preferencias de notificación vive en esta
    // misma pantalla, así que TODA prueba de aquí dispara este GET. Se
    // sirve un estado por defecto (todo activado, como una cuenta sin fila
    // en `notification_preferences`); las pruebas que van sobre las
    // preferencias lo sobreescriben con su propio handler.
    http.get("*/mail/preferences", () => HttpResponse.json(TODAS_ACTIVADAS)),
  );
}

/** Estado por defecto REAL de apps/api: ausencia de fila = todo activado (lista de EXCLUSIÓN, no opt-in). */
const TODAS_ACTIVADAS = {
  tenderMatches: true,
  tenderChanges: true,
  approvals: true,
  submission: true,
  deadlines: true,
  documentExpiration: true,
  postAward: true,
  weeklySummary: true,
};

describe("ConfiguracionPage", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("muestra el estado real de 2FA cuando ya está enrolado", async () => {
    server.use(http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })));
    renderWithProviders(<ConfiguracionPage />);
    expect(await screen.findByText("Enrolado")).toBeInTheDocument();
  }, 15000);

  it("enrola 2FA: muestra el secreto y los códigos de respaldo, y confirma con un código", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: false, enrolledAt: null })),
      http.post("*/auth/2fa/enroll", () =>
        HttpResponse.json(
          { secretBase32: "ABCD1234EFGH5678", otpauthUrl: "otpauth://totp/x", backupCodes: ["AAAA-1111", "BBBB-2222"] },
          { status: 201 },
        ),
      ),
      http.post("*/auth/2fa/verify-enrollment", () =>
        HttpResponse.json({ enrolled: true, stepUpToken: "step-1", expiresAt: "2026-01-01T00:10:00Z" }),
      ),
    );

    renderWithProviders(
      <>
        <Toaster />
        <ConfiguracionPage />
      </>,
    );
    await user.click(await screen.findByRole("button", { name: "Enrolar 2FA" }));

    expect(await screen.findByText("ABCD1234EFGH5678")).toBeInTheDocument();
    expect(screen.getByText("AAAA-1111")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Código de 6 dígitos"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirmar enrolamiento" }));

    expect(await screen.findByText(/2FA enrolado y verificado/)).toBeInTheDocument();
  }, 15000);

  // RF-03 (docs/auditoria-2/ronda5-final.md, BAJA): la pantalla decía
  // "Escanea el código QR" pero nunca renderizaba ningún QR real (solo
  // texto) -- jsdom no implementa `HTMLCanvasElement.getContext` (ver
  // README de apps/web / warnings conocidos de axe-core en esta suite), así
  // que esta prueba no puede pintar un canvas real en jsdom; en su lugar,
  // verifica que el componente invoca la librería REAL de generación de QR
  // (`qrcode`, sin red) con el `otpauthUrl` real del enrolamiento sobre un
  // `<canvas>` accesible -- la generación visual real la cubre `test:e2e`
  // (navegador real, con canvas real) al recorrer la misma pantalla.
  it("RF-03: genera un QR real (canvas) del otpauthUrl, sin dejar de mostrar el secreto como alternativa textual", async () => {
    const user = userEvent.setup();
    const toCanvasSpy = vi.spyOn(QRCode, "toCanvas").mockImplementation(async () => undefined as unknown as void);
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: false, enrolledAt: null })),
      http.post("*/auth/2fa/enroll", () =>
        HttpResponse.json(
          { secretBase32: "ABCD1234EFGH5678", otpauthUrl: "otpauth://totp/Atiende:admin@empresa.com?secret=ABCD1234EFGH5678&issuer=Atiende", backupCodes: ["AAAA-1111"] },
          { status: 201 },
        ),
      ),
    );

    renderWithProviders(<ConfiguracionPage />);
    await user.click(await screen.findByRole("button", { name: "Enrolar 2FA" }));

    // El secreto en texto (alternativa accesible) sigue presente.
    expect(await screen.findByText("ABCD1234EFGH5678")).toBeInTheDocument();

    // El QR real se generó (en cliente, sin red) a partir del MISMO
    // otpauthUrl que devolvió apps/api, sobre un elemento con rol de
    // imagen y nombre accesible.
    await waitFor(() =>
      expect(toCanvasSpy).toHaveBeenCalledWith(
        expect.anything(),
        "otpauth://totp/Atiende:admin@empresa.com?secret=ABCD1234EFGH5678&issuer=Atiende",
        expect.objectContaining({ width: expect.any(Number) }),
      ),
    );
    expect(screen.getByRole("img", { name: /código qr/i })).toBeInTheDocument();

    toCanvasSpy.mockRestore();
  }, 15000);

  // RF-03: si `qrcode` no puede dibujar el QR (canvas no disponible, entrada
  // inválida, etc.), la pantalla no debe quedar en blanco ni romperse --
  // debe ofrecer un texto accesible en el lugar del QR. El secreto y el
  // enlace en texto (siempre presentes junto a este componente) ya
  // cubrían el enrolamiento sin QR; este texto adicional deja explícito
  // que la generación visual falló, en vez de un hueco silencioso.
  it("RF-03: si el QR no se puede generar, ofrece un fallback textual accesible sin romper la pantalla", async () => {
    const user = userEvent.setup();
    const toCanvasSpy = vi.spyOn(QRCode, "toCanvas").mockRejectedValue(new Error("sin canvas real"));
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: false, enrolledAt: null })),
      http.post("*/auth/2fa/enroll", () =>
        HttpResponse.json(
          { secretBase32: "ABCD1234EFGH5678", otpauthUrl: "otpauth://totp/x", backupCodes: ["AAAA-1111"] },
          { status: 201 },
        ),
      ),
    );

    renderWithProviders(<ConfiguracionPage />);
    await user.click(await screen.findByRole("button", { name: "Enrolar 2FA" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/no se pudo generar el código qr/i);
    expect(screen.queryByRole("img", { name: /código qr/i })).not.toBeInTheDocument();
    // El secreto en texto (alternativa accesible) sigue disponible.
    expect(screen.getByText("ABCD1234EFGH5678")).toBeInTheDocument();

    toCanvasSpy.mockRestore();
  }, 15000);

  // Ronda 8a: la pantalla de seguridad NO ofrece desactivar 2FA, regenerar
  // códigos de respaldo ni listar sesiones activas porque apps/api no
  // expone ningún endpoint para eso (se comprobó ruta por ruta en
  // modules/twofa/routes.ts, modules/auth/routes.ts y modules/me/routes.ts).
  // Esta prueba fija esa honestidad: los huecos se DECLARAN en la UI, y no
  // aparece ningún control que fingiría llamarlos.
  it("declara honestamente los huecos de seguridad en vez de ofrecer botones sin endpoint detrás", async () => {
    server.use(http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })));
    renderWithProviders(<ConfiguracionPage />);

    expect(await screen.findByRole("heading", { name: "Lo que esta pantalla todavía no puede hacer" })).toBeInTheDocument();
    expect(screen.getByText(/Desactivar la verificación en dos pasos/)).toBeInTheDocument();
    expect(screen.getByText(/Regenerar códigos de respaldo/)).toBeInTheDocument();
    expect(screen.getByText(/Ver y cerrar tus sesiones activas/)).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /desactivar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /regenerar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cerrar (las )?(demás )?sesiones/i })).not.toBeInTheDocument();
  }, 15000);

  it("adversarial: re-enrolar sobre un 2FA ya verificado muestra el 409 real de apps/api, sin borrar nada", async () => {
    const user = userEvent.setup();
    server.use(
      // `status` dice "no enrolado" (p. ej. una respuesta ya rancia en
      // caché) pero la API sabe la verdad y responde 409 -- la pantalla
      // debe creerle a la API, no a su propio estado.
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: false, enrolledAt: null })),
      http.post("*/auth/2fa/enroll", () =>
        HttpResponse.json(
          {
            type: "https://atiende.example/errors/conflict",
            title: "Este usuario ya tiene 2FA enrolado y verificado. No se permite re-enrolar sin antes desenrolar.",
            status: 409,
          },
          { status: 409 },
        ),
      ),
    );

    renderWithProviders(
      <>
        <Toaster />
        <ConfiguracionPage />
      </>,
    );
    await user.click(await screen.findByRole("button", { name: "Enrolar 2FA" }));

    expect(await screen.findByText(/ya tiene 2FA enrolado y verificado/)).toBeInTheDocument();
    // No se pinta ningún secreto ni código de respaldo inventado.
    expect(screen.queryByLabelText("Códigos de respaldo")).not.toBeInTheDocument();
  }, 15000);

  it("adversarial: un código de confirmación incorrecto muestra el 403 real y deja el enrolamiento a medias, no confirmado", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: false, enrolledAt: null })),
      http.post("*/auth/2fa/enroll", () =>
        HttpResponse.json(
          { secretBase32: "ABCD1234EFGH5678", otpauthUrl: "otpauth://totp/x", backupCodes: ["AAAA-1111"] },
          { status: 201 },
        ),
      ),
      http.post("*/auth/2fa/verify-enrollment", () =>
        HttpResponse.json(
          { type: "https://atiende.example/errors/forbidden", title: "Código TOTP inválido, o ya fue utilizado (replay rechazado).", status: 403 },
          { status: 403 },
        ),
      ),
    );

    renderWithProviders(
      <>
        <Toaster />
        <ConfiguracionPage />
      </>,
    );
    await user.click(await screen.findByRole("button", { name: "Enrolar 2FA" }));
    await user.type(await screen.findByLabelText("Código de 6 dígitos"), "000000");
    await user.click(screen.getByRole("button", { name: "Confirmar enrolamiento" }));

    expect(await screen.findByText(/Código TOTP inválido/)).toBeInTheDocument();
    // Sigue en el paso de confirmación (el secreto no se descarta): el
    // usuario puede reintentar con un código nuevo sin re-enrolar.
    expect(screen.getByText("ABCD1234EFGH5678")).toBeInTheDocument();
    expect(screen.queryByText(/2FA enrolado y verificado/)).not.toBeInTheDocument();
  }, 15000);

  // -------------------------------------------------------------------
  // Ronda 8b (REQ-187): preferencias de notificación por correo
  // -------------------------------------------------------------------

  it("REQ-187: pinta las 8 categorías reales de apps/api, todas activadas cuando no hay fila", async () => {
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })),
      http.get("*/mail/preferences", () => HttpResponse.json(TODAS_ACTIVADAS)),
    );

    renderWithProviders(<ConfiguracionPage />);

    const resumen = await screen.findByLabelText("Resumen semanal");
    expect(resumen).toBeChecked();
    expect(screen.getByLabelText("Aprobaciones pendientes")).toBeChecked();
    // Las 8 de `OPTIONAL_CATEGORIES` (apps/api/src/lib/mail/preferences.ts),
    // ni una más ni una menos.
    expect(screen.getAllByRole("checkbox")).toHaveLength(8);
  }, 15000);

  it("REQ-187: apagar una categoría manda SOLO esa en el PUT y pinta lo que devuelve el servidor", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })),
      http.get("*/mail/preferences", () => HttpResponse.json(TODAS_ACTIVADAS)),
      http.put("*/mail/preferences", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ...TODAS_ACTIVADAS, weeklySummary: false });
      }),
    );

    renderWithProviders(<ConfiguracionPage />);
    await user.click(await screen.findByLabelText("Resumen semanal"));

    await waitFor(() => expect(screen.getByLabelText("Resumen semanal")).not.toBeChecked());
    // `PUT` PARCIAL: las categorías omitidas se dejan como estaban.
    expect(bodies).toEqual([{ weeklySummary: false }]);
    expect(screen.getByLabelText("Aprobaciones pendientes")).toBeChecked();
  }, 15000);

  /**
   * ADVERSARIAL: si el `PUT` falla, la casilla NO puede quedarse en el
   * valor nuevo — sería mentir sobre un cambio que el servidor no aceptó.
   * De ahí que no haya actualización optimista.
   */
  it("adversarial: si el PUT falla, la casilla vuelve a su valor real y se muestra el error", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })),
      http.get("*/mail/preferences", () => HttpResponse.json(TODAS_ACTIVADAS)),
      http.put("*/mail/preferences", () =>
        HttpResponse.json({ title: "Error interno del servidor", status: 500, requestId: "req-500" }, { status: 500 }),
      ),
    );

    renderWithProviders(
      <>
        <Toaster />
        <ConfiguracionPage />
      </>,
    );
    await user.click(await screen.findByLabelText("Resumen semanal"));

    expect(await screen.findByText(/request_id: req-500/)).toBeInTheDocument();
    expect(screen.getByLabelText("Resumen semanal")).toBeChecked();
  }, 15000);

  it("REQ-187: dice que los correos de seguridad de la cuenta no se pueden desactivar", async () => {
    server.use(http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })));
    renderWithProviders(<ConfiguracionPage />);

    expect(await screen.findByText(/Los correos de seguridad de la cuenta no se pueden desactivar/)).toBeInTheDocument();
  }, 15000);

  it("un fallo al leer las preferencias no rompe el resto de la pantalla (2FA sigue visible)", async () => {
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })),
      http.get("*/mail/preferences", () =>
        HttpResponse.json({ title: "Error interno del servidor", status: 500, requestId: "req-pref" }, { status: 500 }),
      ),
    );

    renderWithProviders(<ConfiguracionPage />);

    expect(await screen.findByText(/request_id: req-pref/)).toBeInTheDocument();
    expect(screen.getByText("Enrolado")).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  }, 15000);
});
