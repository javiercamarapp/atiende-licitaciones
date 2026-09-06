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
 */
function mockAuthenticatedSessionWithOneOrgAdmin() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
  );
}

describe("TarifasAprobadasPage (WI-04)", () => {
  beforeEach(() => {
    mockAuthenticatedSessionWithOneOrgAdmin();
  });

  it("deshabilita Aprobar/Rechazar de una fila mientras su propia decisión está pendiente", async () => {
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

    const approveButton = screen.getByRole("button", { name: "Aprobar" });
    const rejectButton = screen.getByRole("button", { name: "Rechazar" });
    expect(approveButton).toBeEnabled();
    expect(rejectButton).toBeEnabled();

    await user.click(approveButton);

    await waitFor(() => expect(screen.getByRole("button", { name: "Aprobando…" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Rechazar" })).toBeDisabled();

    resolveApprove?.();

    // Tras resolverse, la tarifa ya no está en "draft" -- desaparecen los
    // botones de decisión de esta fila (no solo se re-habilitan).
    await waitFor(() => expect(screen.queryByRole("button", { name: /Aprobar|Aprobando|Rechazar|Rechazando/ })).not.toBeInTheDocument());
  });

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

    await user.click(screen.getByRole("button", { name: "Rechazar" }));

    expect(await screen.findByText(/ya cambió de estado/)).toBeInTheDocument();
    // La lista se refrescó: la fila ya no ofrece Aprobar/Rechazar (dejó de
    // estar en "draft" según la respuesta actualizada del servidor).
    await waitFor(() => expect(screen.queryByRole("button", { name: /Aprobar|Rechazar/ })).not.toBeInTheDocument());
  });

  // WI-06 (docs/auditoria-2/reverificacion-final-integrada.md): un doble
  // clic físico verdaderamente simultáneo (dos eventos de clic reales, sin
  // ceder el control al event loop entre ellos) podía pasar el chequeo de
  // `disabled` ANTES de que React confirmara el re-render que sigue al
  // primer `mutate()` -- `fireEvent.click` dos veces sin `await` entre
  // medias reproduce exactamente esa ventana (a diferencia de
  // `userEvent.click`, que ya cede el control al event loop internamente).
  // El guard síncrono (`useRef` fijado ANTES de `mutate()`) debe cerrarla:
  // sin él, este test detecta 2 peticiones POST en vez de 1.
  it("un doble clic físico real (sin esperar entre clics) en Aprobar dispara UNA sola petición de red", async () => {
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
    const approveButton = screen.getByRole("button", { name: "Aprobar" });

    // Sin `await` entre los dos clics: ambos corren en el mismo tick
    // síncrono, antes de cualquier re-render.
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);

    await waitFor(() => expect(approveCalls).toBeGreaterThanOrEqual(1));
    // Margen para que un segundo POST espurio (si el guard fallara) alcance
    // a llegar antes de aserirlo.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(approveCalls).toBe(1);
    expect(screen.queryByText(/ya cambió de estado/)).not.toBeInTheDocument();
  });
});
