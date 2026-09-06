import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import RedaccionPage from "@/pages/preparacion/RedaccionPage";

const TENDER = { id: "tender-1", title: "Convocatoria de prueba", source: "test", externalId: "ext-1", contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", submissionDeadline: null, publishedAt: null, url: null, status: "in_progress", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    http.get("*/tenders", () => HttpResponse.json({ items: [TENDER], nextCursor: null })),
    http.get("*/expediente/tenders/:tenderId/matrix", () => HttpResponse.json([])),
    http.get("*/company/capabilities", () => HttpResponse.json([])),
    http.get("*/company/experience", () => HttpResponse.json([])),
    http.get("*/company/documents", () => HttpResponse.json([])),
    http.get("*/company/signatories", () => HttpResponse.json([])),
    http.get("*/company/rates", () => HttpResponse.json([])),
    http.get("*/expediente/tenders/:tenderId/proposal", () =>
      HttpResponse.json({
        id: "prop-1",
        tenderId: TENDER.id,
        title: "Expediente — Convocatoria de prueba",
        status: "draft",
        version: 1,
        invalidatedAt: null,
        invalidatedReason: null,
        inputsHash: null,
        ivaRate: 0.16,
        economicTotals: null,
        generationReport: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    ),
    http.get("*/expediente/tenders/:tenderId/proposal/sections", () =>
      HttpResponse.json([
        { id: "sec-1", sectionKey: "technical:req-1", title: "Requisito 1", content: "PENDIENTE: sin mapeo declarado.", sources: [], version: 1, updatedAt: "2026-01-02T00:00:00Z" },
      ]),
    ),
  );
}

describe("RedaccionPage", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("muestra una sección bloqueada como PENDIENTE, nunca un valor inventado", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RedaccionPage />);
    await user.click(await screen.findByRole("combobox", { name: "Convocatoria" }));
    await user.click(await screen.findByRole("option", { name: TENDER.title }));

    expect(await screen.findByText("Bloqueado / pendiente")).toBeInTheDocument();
  }, 20000);
});
