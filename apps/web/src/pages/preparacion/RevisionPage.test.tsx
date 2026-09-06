import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import RevisionPage from "@/pages/preparacion/RevisionPage";

const TENDER = { id: "tender-1", title: "Convocatoria de prueba", source: "test", externalId: "ext-1", contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", submissionDeadline: null, publishedAt: null, url: null, status: "in_progress", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

function mockSession(role: string) {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "writer@empresa.com", fullName: "Writer" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role }])),
    http.get("*/tenders", () => HttpResponse.json({ items: [TENDER], nextCursor: null })),
    http.get("*/expediente/tenders/:tenderId/approval", () =>
      HttpResponse.json({
        state: "en_revision",
        approvals: [{ scope: "expediente", scopeRef: "expediente", approvedBy: null, approvedByRole: "reviewer", approvedAt: "2026-01-01T00:00:00Z", inputsHash: "abc", status: "invalidada" }],
        comments: [{ scopeRef: "expediente", authorId: "user-2", authorRole: "reviewer", text: "Falta corregir el anexo 3.", createdAt: "2026-01-02T00:00:00Z" }],
        currentInputsHash: "def456",
        fullyApproved: false,
      }),
    ),
  );
}

describe("RevisionPage", () => {
  beforeEach(() => {
    mockSession("writer");
  });

  it("A12: un rol indebido (writer) no puede aprobar -- el botón de aprobar no se ofrece", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RevisionPage />);
    await user.click(await screen.findByRole("combobox", { name: "Convocatoria" }));
    await user.click(await screen.findByRole("option", { name: TENDER.title }));

    expect(await screen.findByText(/no puede aprobar/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aprobar expediente" })).not.toBeInTheDocument();
  }, 20000);

  it("muestra una aprobación invalidada tras un cambio (A11)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RevisionPage />);
    await user.click(await screen.findByRole("combobox", { name: "Convocatoria" }));
    await user.click(await screen.findByRole("option", { name: TENDER.title }));

    expect(await screen.findByText("Invalidada tras un cambio")).toBeInTheDocument();
  }, 20000);
});
