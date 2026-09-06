import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import AprobacionesPage from "@/pages/preparacion/AprobacionesPage";

const TENDER = { id: "tender-1", title: "Convocatoria de prueba", source: "test", externalId: "ext-1", contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", submissionDeadline: null, publishedAt: null, url: null, status: "in_progress", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    http.get("*/tenders", () => HttpResponse.json({ items: [TENDER], nextCursor: null })),
    http.get("*/expediente/tenders/:tenderId/approval", () =>
      HttpResponse.json({ state: "en_revision", approvals: [], comments: [], currentInputsHash: "abc", fullyApproved: false }),
    ),
  );
}

describe("AprobacionesPage", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("lista el estado de aprobación real por convocatoria con enlace a Revisión", async () => {
    renderWithProviders(<AprobacionesPage />);
    expect(await screen.findByText(TENDER.title)).toBeInTheDocument();
    expect(await screen.findByText("En revisión")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Revisar/ })).toHaveAttribute("href", `/preparacion/revision?tenderId=${TENDER.id}`);
  }, 20000);
});
