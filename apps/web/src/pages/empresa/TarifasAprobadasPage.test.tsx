import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import { Toaster } from "@/components/ui/sonner";
import TarifasAprobadasPage from "@/pages/empresa/TarifasAprobadasPage";

const RATE_BASE = {
  id: "rate-1",
  itemCode: "SRV-001",
  description: "Servicio de prueba",
  unit: "servicio",
  unitPrice: 1000,
  currency: "MXN",
  status: "draft" as const,
  approvedBy: null,
  approvedAt: null,
  validFrom: null,
  validUntil: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/**
 * WI-04 (docs/auditoria-2/web-integrado.md): monta la página ya autenticada
 * y con una organización activa, simulando el arranque real de sesión
 * (`AuthProvider` restaura desde un refresh token guardado) en vez de un
 * login completo — más corto y suficiente para probar el comportamiento de
 * los botones Aprobar/Rechazar, que no depende del flujo de login.
 *
 * Ronda 5 (REQ-044/064): aprobar exige X-Step-Up -- se simula 2FA ya
 * enrolado (`GET /auth/2fa/status` → enrolled:true) para poder llegar al
 * modal de código y, tras verificarlo, a la mutación real de aprobar.
 */
function mockAuthenticatedSessionWithOneOrgAdmin() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })),
    http.post("*/auth/2fa/step-up", () => HttpResponse.json({ stepUpToken: "step-up-1", expiresAt: "2026-01-01T00:10:00Z" })),
  );
}

async function approveViaStepUp(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Aprobar" }));
  await user.type(await screen.findByLabelText("Código TOTP o de respaldo", {}, { timeout: 10000 }), "123456");
  await user.click(screen.getByRole("button", { name: "Verificar y continuar" }));
}

describe("TarifasAprobadasPage (WI-04, ronda 5: step-up 2FA)", () => {
  beforeEach(() => {
    mockAuthenticatedSessionWithOneOrgAdmin();
  });

  it("deshabilita Aprobar/Rechazar de una fila mientras su propia decisión está pendiente (tras verificar el step-up)", async () => {
    const user = userEvent.setup();
    let resolveApprove: (() => void) | undefined;
    let approved = false;
    server.use(
      // El refetch disparado por invalidateQueries (dentro de onSuccess,
      // ver useCompany.ts) debe ver el estado YA actualizado — de lo
      // contrario los botones de la fila nunca desaparecerían.
      http.get("*/company/rates", () => HttpResponse.json([approved ? { ...RATE_BASE, status: "approved", approvedBy: "user-1" } : RATE_BASE])),
      http.post("*/company/rates/:id/approve", async () => {
        await new Promise<void>((resolve) => {
          resolveApprove = resolve;
        });
        approved = true;
        return HttpResponse.json({ ...RATE_BASE, status: "approved", approvedBy: "user-1" });
      }),
    );

    renderWithProviders(<TarifasAprobadasPage />);
    await screen.findByText("SRV-001");

    const rejectButton = screen.getByRole("button", { name: "Rechazar" });
    expect(screen.getByRole("button", { name: "Aprobar" })).toBeEnabled();
    expect(rejectButton).toBeEnabled();

    await approveViaStepUp(user);

    await waitFor(() => expect(screen.getByRole("button", { name: "Aprobando…" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Rechazar" })).toBeDisabled();

    resolveApprove?.();

    // Tras resolverse, la tarifa ya no está en "draft" -- desaparecen los
    // botones de decisión de esta fila (no solo se re-habilitan).
    await waitFor(() => expect(screen.queryByRole("button", { name: /Aprobar|Aprobando|Rechazar|Rechazando/ })).not.toBeInTheDocument());
  }, 15000);

  it("muestra un mensaje honesto de 409 (la tarifa ya cambió de estado) y refresca la lista", async () => {
    const user = userEvent.setup();
    let callCount = 0;
    server.use(
      http.get("*/company/rates", () => {
        callCount += 1;
        // La segunda vez que la lista se lee (tras el 409), ya refleja que
        // otra persona aprobó la tarifa primero.
        return HttpResponse.json([callCount === 1 ? RATE_BASE : { ...RATE_BASE, status: "approved", approvedBy: "otra-persona" }]);
      }),
      http.post("*/company/rates/:id/reject", () =>
        HttpResponse.json({ type: "conflict", title: "La tarifa ya no está en borrador", status: 409, requestId: "req-409" }, { status: 409 }),
      ),
    );

    renderWithProviders(
      <>
        <Toaster />
        <TarifasAprobadasPage />
      </>,
    );
    await screen.findByText("SRV-001");

    // Rechazar NO exige step-up (solo aprobar, REQ-044/064) -- se conserva
    // el flujo directo de antes.
    await user.click(screen.getByRole("button", { name: "Rechazar" }));

    expect(await screen.findByText(/ya cambió de estado/)).toBeInTheDocument();
    // La lista se refrescó: la fila ya no ofrece Aprobar/Rechazar (dejó de
    // estar en "draft" según la respuesta actualizada del servidor).
    await waitFor(() => expect(screen.queryByRole("button", { name: /Aprobar|Rechazar/ })).not.toBeInTheDocument());
  }, 15000);

  // WI-06 (docs/auditoria-2/reverificacion-final-integrada.md), reubicado en
  // ronda 5: el punto real de doble-envío ya no es el botón "Aprobar" (que
  // ahora solo abre el modal de step-up) sino "Verificar y continuar" --
  // dos clics físicos simultáneos ahí, sin esperar entre ellos, deben
  // producir UNA sola petición real de aprobar.
  it("un doble clic físico real en \"Verificar y continuar\" dispara UNA sola petición de aprobar", async () => {
    const user = userEvent.setup();
    let approveCalls = 0;
    server.use(
      http.get("*/company/rates", () => HttpResponse.json([RATE_BASE])),
      http.post("*/company/rates/:id/approve", async () => {
        approveCalls += 1;
        return HttpResponse.json({ ...RATE_BASE, status: "approved", approvedBy: "user-1" });
      }),
    );

    renderWithProviders(
      <>
        <Toaster />
        <TarifasAprobadasPage />
      </>,
    );
    await screen.findByText("SRV-001");

    await user.click(screen.getByRole("button", { name: "Aprobar" }));
    await user.type(await screen.findByLabelText("Código TOTP o de respaldo", {}, { timeout: 10000 }), "123456");
    const verifyButton = screen.getByRole("button", { name: "Verificar y continuar" });

    // Sin `await` entre los dos clics: ambos corren en el mismo tick
    // síncrono, antes de cualquier re-render.
    fireEvent.click(verifyButton);
    fireEvent.click(verifyButton);

    await waitFor(() => expect(approveCalls).toBeGreaterThanOrEqual(1));
    // Margen para que un segundo POST espurio (si el guard fallara) alcance
    // a llegar antes de aserirlo.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(approveCalls).toBe(1);
    expect(screen.queryByText(/ya cambió de estado/)).not.toBeInTheDocument();
  }, 15000);

  it("dirige a Configuración cuando el usuario no tiene 2FA enrolado, en vez de pedir un código que la API rechazaría", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/company/rates", () => HttpResponse.json([RATE_BASE])),
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: false, enrolledAt: null })),
    );

    renderWithProviders(<TarifasAprobadasPage />);
    await screen.findByText("SRV-001");

    await user.click(screen.getByRole("button", { name: "Aprobar" }));
    expect(await screen.findByText("Aún no tienes 2FA enrolado", {}, { timeout: 10000 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ir a Configuración/ })).toHaveAttribute("href", "/configuracion");
  }, 15000);

  // R5-09 (reverificación api ronda 5): antes de esta ronda, `POST
  // /auth/2fa/step-up` no declaraba ni la organización activa ni el
  // propósito de la acción, así que la sesión de step-up quedaba
  // "genérica" del lado del servidor -- servía para aprobar cualquier
  // tarifa/expediente de cualquier organización dentro de su vigencia (ver
  // apps/api/src/lib/step-up.ts `requireStepUp`). apps/api pasará a
  // exigirlos (403 si faltan).
  it("pide el step-up con la organización activa (X-Org-Id) y el propósito exacto de la acción (R5-09)", async () => {
    const user = userEvent.setup();
    let capturedOrgIdHeader: string | null = null;
    let capturedBody: unknown;
    server.use(
      http.get("*/company/rates", () => HttpResponse.json([RATE_BASE])),
      http.post("*/auth/2fa/step-up", async ({ request }) => {
        capturedOrgIdHeader = request.headers.get("x-org-id");
        capturedBody = await request.json();
        return HttpResponse.json({ stepUpToken: "step-up-1", expiresAt: "2026-01-01T00:10:00Z" });
      }),
      http.post("*/company/rates/:id/approve", () => HttpResponse.json({ ...RATE_BASE, status: "approved", approvedBy: "user-1" })),
    );

    renderWithProviders(<TarifasAprobadasPage />);
    await screen.findByText("SRV-001");
    await approveViaStepUp(user);

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedOrgIdHeader).toBe("org-a");
    expect(capturedBody).toEqual({ code: "123456", purpose: "company.rate_approval" });
  }, 15000);
});
