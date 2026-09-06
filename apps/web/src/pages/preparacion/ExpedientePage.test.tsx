import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import ExpedientePage from "@/pages/preparacion/ExpedientePage";

const TENDER = { id: "tender-1", title: "Convocatoria de prueba", source: "test", externalId: "ext-1", contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", submissionDeadline: null, publishedAt: null, url: null, status: "in_progress", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    http.get("*/tenders", () => HttpResponse.json({ items: [TENDER], nextCursor: null })),
    http.get("*/expediente/tenders/:tenderId/documents", () => HttpResponse.json([])),
    http.get("*/expediente/tenders/:tenderId/matrix", () => HttpResponse.json([])),
    http.get("*/expediente/tenders/:tenderId/proposal", () => new HttpResponse(null, { status: 404 })),
    http.get("*/expediente/tenders/:tenderId/checklist", () => HttpResponse.json({ overallStatus: "verde", items: [] })),
    http.get("*/expediente/tenders/:tenderId/approval", () => new HttpResponse(null, { status: 404 })),
    http.get("*/expediente/tenders/:tenderId/package/latest", () => new HttpResponse(null, { status: 404 })),
    http.get("*/expediente/tenders/:tenderId/submission", () => HttpResponse.json(null)),
  );
}

describe("ExpedientePage", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("resume el estado real del expediente por convocatoria con enlaces a cada módulo", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExpedientePage />);
    await user.click(await screen.findByRole("combobox", { name: "Convocatoria" }));
    await user.click(await screen.findByRole("option", { name: TENDER.title }));

    expect(await screen.findByText("Análisis de bases")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Ir al módulo/ }).length).toBeGreaterThan(3);
  }, 20000);
});
