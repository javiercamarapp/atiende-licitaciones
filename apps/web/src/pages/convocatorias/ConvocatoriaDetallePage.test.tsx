import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import ConvocatoriaDetallePage from "@/pages/convocatorias/ConvocatoriaDetallePage";

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
  );
}

function renderDetail(tenderId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/convocatorias/descubrimiento/:tenderId" element={<ConvocatoriaDetallePage />} />
    </Routes>,
    { route: `/convocatorias/descubrimiento/${tenderId}` },
  );
}

describe("ConvocatoriaDetallePage -- guard 404 de tenant cruzado", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("muestra la página 404 dedicada cuando el tenderId pertenece a otra organización (403 real de la API)", async () => {
    server.use(
      http.get("*/tenders/:id", () =>
        HttpResponse.json({ type: "forbidden", title: "No tienes acceso a esta convocatoria", status: 403, requestId: "req-403" }, { status: 403 }),
      ),
    );
    renderDetail("tender-de-otra-org");

    expect(await screen.findByText("Recurso no encontrado")).toBeInTheDocument();
    // Nunca debe filtrar el mensaje crudo del 403 (confirmaría que existe).
    expect(screen.queryByText(/No tienes acceso/)).not.toBeInTheDocument();
  }, 15000);

  it("muestra la convocatoria real cuando sí pertenece a la organización activa", async () => {
    server.use(
      http.get("*/tenders/:id", () =>
        HttpResponse.json({
          id: "tender-1",
          source: "test",
          externalId: "ext-1",
          title: "Convocatoria propia",
          contractingBody: "Entidad X",
          cpvCodes: [],
          budgetAmount: null,
          currency: "MXN",
          submissionDeadline: null,
          publishedAt: null,
          url: null,
          status: "in_progress",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }),
      ),
      http.get("*/tenders/:id/versions", () => HttpResponse.json([])),
      http.get("*/tenders/:id/change-events", () => HttpResponse.json([])),
    );
    renderDetail("tender-1");

    expect(await screen.findByText("Convocatoria propia")).toBeInTheDocument();
    expect(screen.queryByText("Recurso no encontrado")).not.toBeInTheDocument();
  }, 15000);
});
