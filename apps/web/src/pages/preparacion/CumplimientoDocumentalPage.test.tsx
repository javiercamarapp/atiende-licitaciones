import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import CumplimientoDocumentalPage from "@/pages/preparacion/CumplimientoDocumentalPage";

const TENDER = { id: "tender-1", title: "Convocatoria de prueba", source: "test", externalId: "ext-1", contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", submissionDeadline: null, publishedAt: null, url: null, status: "in_progress", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    http.get("*/tenders", () => HttpResponse.json({ items: [TENDER], nextCursor: null })),
    http.get("*/expediente/tenders/:tenderId/checklist", () =>
      HttpResponse.json({
        overallStatus: "ambar",
        items: [{ id: "c1", dimension: "documentos", result: "ambar", label: "Documentos", notes: "Falta un anexo", evidenceRef: null, checkedAt: "2026-01-02T00:00:00Z" }],
      }),
    ),
  );
}

describe("CumplimientoDocumentalPage", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("muestra el resultado real por dimensión del checklist de integridad", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CumplimientoDocumentalPage />);
    await user.click(await screen.findByRole("combobox", { name: "Convocatoria" }));
    await user.click(await screen.findByRole("option", { name: TENDER.title }));

    expect(await screen.findByText("Falta un anexo")).toBeInTheDocument();
    expect(screen.getByText("General: Ámbar")).toBeInTheDocument();
  }, 20000);
});
