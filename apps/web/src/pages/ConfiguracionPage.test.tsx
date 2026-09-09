import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QRCode from "qrcode";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens, getTokens } from "@/lib/api/session";
import { Toaster } from "@/components/ui/sonner";
import ConfiguracionPage from "@/pages/ConfiguracionPage";

/**
 * E19/E21 (docs/BACKLOG.md): cuenta base para la mayoría de las pruebas --
 * CON contraseña propia y SIN Google vinculado (el caso más común). Las
 * pruebas de la sección de Google/contraseña que necesitan el estado
 * contrario lo declaran con su propio `http.get("*\/me", ...)`.
 */
function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () =>
      HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin", hasPassword: true, googleLinked: false }),
    ),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    // Ronda 8b: la tarjeta de preferencias de notificación vive en esta
    // misma pantalla, así que TODA prueba de aquí dispara este GET. Se
    // sirve un estado por defecto (todo activado, como una cuenta sin fila
    // en `notification_preferences`); las pruebas que van sobre las
    // preferencias lo sobreescriben con su propio handler.
    http.get("*/mail/preferences", () => HttpResponse.json(TODAS_ACTIVADAS)),
    // E21: la sección de sesiones activas también vive en esta pantalla --
    // TODA prueba de aquí dispara este GET. Por defecto sin sesiones (las
    // pruebas de esa sección lo sobreescriben con su propio handler).
    http.get("*/auth/sessions", () => HttpResponse.json({ sessions: [] })),
    // Logout es best-effort del lado del cliente (ver useAuth.tsx) -- se
    // sirve 200 para que las pruebas de cambio de contraseña (que terminan
    // en logout) no dependan de un fallo de red silencioso.
    http.post("*/auth/logout", () => new HttpResponse(null, { status: 204 })),
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

    // `findByRole("status")` ya no sirve aquí: E21 agregó otro `role="status"`
    // a la pantalla (el `EmptyState` de "Sin sesiones activas" de
    // SessionsSection, sesiones vacías por defecto en `mockAuthenticatedSession`)
    // -- se busca por texto en vez de por rol para no depender de que
    // exista un único `status` en toda la página.
    expect(await screen.findByText(/no se pudo generar el código qr/i)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /código qr/i })).not.toBeInTheDocument();
    // El secreto en texto (alternativa accesible) sigue disponible.
    expect(screen.getByText("ABCD1234EFGH5678")).toBeInTheDocument();

    toCanvasSpy.mockRestore();
  }, 15000);

  // E19/E21: los huecos declarados hasta ronda 8a ya se cerraron -- esta
  // prueba fija lo contrario de la vieja "declara honestamente los huecos":
  // los controles reales SÍ aparecen una vez enrolado, con endpoint real
  // detrás (ver las suites dedicadas más abajo para el flujo completo de
  // cada uno).
  it("una vez enrolado, ofrece desactivar 2FA y regenerar códigos de respaldo con controles reales", async () => {
    server.use(http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })));
    renderWithProviders(<ConfiguracionPage />);

    expect(await screen.findByRole("button", { name: /desactivar 2fa/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /regenerar códigos de respaldo/i })).toBeInTheDocument();
  }, 15000);

  // -------------------------------------------------------------------
  // E21: desactivar 2FA (POST /auth/2fa/disable) y regenerar códigos de
  // respaldo (POST /auth/2fa/backup-codes/regenerate) -- ambos exigen un
  // stepUpToken vigente, pedido en el mismo StepUpDialog ya cubierto por
  // TarifasAprobadasPage/RevisionPage (aquí solo se cubre el cableado
  // propio de esta pantalla, no el diálogo en sí).
  // -------------------------------------------------------------------

  /** Solo la parte de "ya está abierto el StepUpDialog, ingresa el código y confirma". */
  async function enterStepUpCode(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText("Código TOTP o de respaldo"), "123456");
    await user.click(screen.getByRole("button", { name: "Verificar y continuar" }));
  }

  /** Click en el botón que ABRE el StepUpDialog de esta pantalla, más completar el código. */
  async function completeStepUp(user: ReturnType<typeof userEvent.setup>, openButtonName: RegExp) {
    await user.click(await screen.findByRole("button", { name: openButtonName }));
    await enterStepUpCode(user);
  }

  it("E21: desactiva 2FA tras un step-up válido", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })),
      http.post("*/auth/2fa/step-up", () => HttpResponse.json({ stepUpToken: "step-disable-1", expiresAt: "2026-01-01T00:10:00Z" })),
      http.post("*/auth/2fa/disable", () => HttpResponse.json({ disabled: true })),
    );

    renderWithProviders(
      <>
        <Toaster />
        <ConfiguracionPage />
      </>,
    );
    await completeStepUp(user, /desactivar 2fa/i);

    expect(await screen.findByText("2FA desactivado.")).toBeInTheDocument();
  }, 15000);

  it("E21: adversarial -- desactivar 2FA sin otro método de acceso muestra el 409 real, sin borrar nada", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })),
      http.post("*/auth/2fa/step-up", () => HttpResponse.json({ stepUpToken: "step-disable-2", expiresAt: "2026-01-01T00:10:00Z" })),
      http.post("*/auth/2fa/disable", () =>
        HttpResponse.json(
          { title: "No se puede desactivar la verificación en dos pasos: esta cuenta no tiene contraseña ni una cuenta de Google vinculada.", status: 409 },
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
    await completeStepUp(user, /desactivar 2fa/i);

    expect(await screen.findByText(/no se puede desactivar la verificación en dos pasos/i)).toBeInTheDocument();
    // El botón de desactivar sigue ahí -- no se pintó ningún estado de "ya desactivado".
    expect(screen.getByRole("button", { name: /desactivar 2fa/i })).toBeInTheDocument();
  }, 15000);

  it("E21: regenera códigos de respaldo y los muestra una sola vez", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })),
      http.post("*/auth/2fa/step-up", () => HttpResponse.json({ stepUpToken: "step-regen-1", expiresAt: "2026-01-01T00:10:00Z" })),
      http.post("*/auth/2fa/backup-codes/regenerate", () => HttpResponse.json({ backupCodes: ["ZZZZ-9999", "YYYY-8888"] })),
    );

    renderWithProviders(<ConfiguracionPage />);
    await completeStepUp(user, /regenerar códigos de respaldo/i);

    expect(await screen.findByText("ZZZZ-9999")).toBeInTheDocument();
    expect(screen.getByText("YYYY-8888")).toBeInTheDocument();
    // Al confirmar que ya se guardaron, el panel desaparece y vuelven los botones.
    await user.click(screen.getByRole("button", { name: "Ya los guardé" }));
    expect(screen.queryByText("ZZZZ-9999")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /regenerar códigos de respaldo/i })).toBeInTheDocument();
  }, 15000);

  // -------------------------------------------------------------------
  // E21: cambiar contraseña (POST /auth/password/change)
  // -------------------------------------------------------------------

  it("E21: cambia la contraseña tras step-up y cierra la sesión local (todas las sesiones se revocan del lado del servidor)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })),
      http.post("*/auth/2fa/step-up", () => HttpResponse.json({ stepUpToken: "step-pwd-1", expiresAt: "2026-01-01T00:10:00Z" })),
      http.post("*/auth/password/change", () => HttpResponse.json({ changed: true })),
    );

    renderWithProviders(
      <>
        <Toaster />
        <ConfiguracionPage />
      </>,
    );

    await user.type(await screen.findByLabelText("Contraseña actual"), "vieja-secreta");
    await user.type(screen.getByLabelText("Contraseña nueva"), "nueva-secreta-123");
    await user.type(screen.getByLabelText("Confirmar contraseña nueva"), "nueva-secreta-123");
    await user.click(screen.getByRole("button", { name: "Cambiar contraseña" }));

    expect(await screen.findByText(/confirma el cambio de contraseña/i)).toBeInTheDocument();
    await enterStepUpCode(user);

    expect(await screen.findByText(/vuelve a iniciar sesión con tu contraseña nueva/i)).toBeInTheDocument();
    // logout() limpia el refresh token local -- coherente con que el
    // servidor ya revocó todas las sesiones, esta incluida.
    await waitFor(() => expect(getTokens().refreshToken).toBeNull());
  }, 15000);

  it("E21: adversarial -- las contraseñas nuevas que no coinciden se rechazan en cliente, sin llamar a la API", async () => {
    const user = userEvent.setup();
    const changeCalls: unknown[] = [];
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })),
      http.post("*/auth/password/change", async ({ request }) => {
        changeCalls.push(await request.json());
        return HttpResponse.json({ changed: true });
      }),
    );

    renderWithProviders(<ConfiguracionPage />);
    await user.type(await screen.findByLabelText("Contraseña actual"), "vieja-secreta");
    await user.type(screen.getByLabelText("Contraseña nueva"), "nueva-secreta-123");
    await user.type(screen.getByLabelText("Confirmar contraseña nueva"), "otra-cosa-distinta");
    await user.click(screen.getByRole("button", { name: "Cambiar contraseña" }));

    expect(await screen.findByText("Las contraseñas nuevas no coinciden.")).toBeInTheDocument();
    expect(changeCalls).toEqual([]);
    // Sin StepUpDialog abierto: la validación de cliente corta ANTES de pedir el step-up.
    expect(screen.queryByText(/confirma el cambio de contraseña/i)).not.toBeInTheDocument();
  }, 15000);

  it("E21: una cuenta solo-Google (sin contraseña propia) no ve el formulario de cambio de contraseña", async () => {
    server.use(
      http.get("*/me", () =>
        HttpResponse.json({ id: "user-1", email: "solo-google@empresa.com", fullName: null, hasPassword: false, googleLinked: true }),
      ),
    );
    renderWithProviders(<ConfiguracionPage />);

    expect(await screen.findByText(/esta cuenta no tiene contraseña propia \(solo google\)/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Contraseña actual")).not.toBeInTheDocument();
  }, 15000);

  // -------------------------------------------------------------------
  // E19: desvincular Google (POST /auth/google/unlink)
  // -------------------------------------------------------------------

  it("E19: cuenta sin Google vinculado -- muestra 'Sin vincular' y ningún botón de desvincular", async () => {
    renderWithProviders(<ConfiguracionPage />);

    expect(await screen.findByText("Sin vincular")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /desvincular google/i })).not.toBeInTheDocument();
  }, 15000);

  it("E19: desvincula Google tras step-up y refresca el estado de la cuenta", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/me", () =>
        HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin", hasPassword: true, googleLinked: true }),
      ),
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })),
      http.post("*/auth/2fa/step-up", () => HttpResponse.json({ stepUpToken: "step-unlink-1", expiresAt: "2026-01-01T00:10:00Z" })),
      http.post("*/auth/google/unlink", () => HttpResponse.json({ unlinked: true })),
    );

    renderWithProviders(
      <>
        <Toaster />
        <ConfiguracionPage />
      </>,
    );
    expect(await screen.findByText("Vinculada")).toBeInTheDocument();

    // Tras desvincular, `refreshUser()` vuelve a pedir /me -- se sirve "ya
    // desvinculado" para que la pantalla refleje el cambio real.
    server.use(
      http.get("*/me", () =>
        HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin", hasPassword: true, googleLinked: false }),
      ),
    );

    await completeStepUp(user, /desvincular google/i);

    expect(await screen.findByText("Cuenta de Google desvinculada.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Sin vincular")).toBeInTheDocument());
  }, 15000);

  it("E19: Google vinculado pero sin contraseña propia -- explica por qué no se puede desvincular, sin ofrecer el botón", async () => {
    server.use(
      http.get("*/me", () =>
        HttpResponse.json({ id: "user-1", email: "solo-google@empresa.com", fullName: null, hasPassword: false, googleLinked: true }),
      ),
    );
    renderWithProviders(<ConfiguracionPage />);

    expect(await screen.findByText(/no se puede desvincular/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /desvincular google/i })).not.toBeInTheDocument();
  }, 15000);

  // -------------------------------------------------------------------
  // E21: sesiones activas (GET/DELETE /auth/sessions, POST
  // /auth/sessions/revoke-others)
  // -------------------------------------------------------------------

  const DOS_SESIONES = {
    sessions: [
      { id: "sess-1", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-02-01T00:00:00Z", ipAddress: "10.0.0.1", userAgent: "Chrome/Mac" },
      { id: "sess-2", createdAt: "2026-01-02T00:00:00Z", expiresAt: "2026-02-02T00:00:00Z", ipAddress: "10.0.0.2", userAgent: "Firefox/Linux" },
    ],
  };

  it("E21: lista las sesiones reales de la cuenta", async () => {
    server.use(http.get("*/auth/sessions", () => HttpResponse.json(DOS_SESIONES)));
    renderWithProviders(<ConfiguracionPage />);

    expect(await screen.findByText("10.0.0.1")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.2")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Cerrar" })).toHaveLength(2);
  }, 15000);

  it("E21: sin sesiones, muestra un estado vacío honesto", async () => {
    renderWithProviders(<ConfiguracionPage />);
    expect(await screen.findByText("Sin sesiones activas")).toBeInTheDocument();
  }, 15000);

  it("E21: cierra una sesión concreta", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/auth/sessions", () => HttpResponse.json(DOS_SESIONES)),
      http.delete("*/auth/sessions/sess-1", () => HttpResponse.json({ revoked: true })),
    );

    renderWithProviders(
      <>
        <Toaster />
        <ConfiguracionPage />
      </>,
    );
    const row = (await screen.findByText("10.0.0.1")).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Cerrar" }));

    expect(await screen.findByText("Sesión cerrada.")).toBeInTheDocument();
  }, 15000);

  it("E21: cierra todas las demás sesiones usando el refresh token de esta pestaña", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.get("*/auth/sessions", () => HttpResponse.json(DOS_SESIONES)),
      http.post("*/auth/sessions/revoke-others", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ revokedCount: 1 });
      }),
    );

    renderWithProviders(
      <>
        <Toaster />
        <ConfiguracionPage />
      </>,
    );
    await user.click(await screen.findByRole("button", { name: "Cerrar las demás sesiones" }));

    expect(await screen.findByText("1 sesión(es) cerrada(s).")).toBeInTheDocument();
    expect(bodies).toEqual([{ refreshToken: "ref-1" }]);
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
