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
  );
}

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
});
