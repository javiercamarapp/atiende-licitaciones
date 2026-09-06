import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import AnalisisBasesPage from "@/pages/evaluacion/AnalisisBasesPage";

const TENDER = { id: "tender-1", title: "Convocatoria de prueba", source: "test", externalId: "ext-1", contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", submissionDeadline: null, publishedAt: null, url: null, status: "in_progress", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    http.get("*/tenders", () => HttpResponse.json({ items: [TENDER], nextCursor: null })),
    http.get("*/expediente/tenders/:tenderId/documents", () =>
      HttpResponse.json([
        {
          id: "doc-1",
          documentKind: "bases",
          originalFilename: "bases.pdf",
          mimeType: "application/pdf",
          fileHash: "abc",
          fileSizeBytes: 1000,
          pageCount: null,
          textExtractionStatus: "requires_ocr",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ]),
    ),
    http.get("*/expediente/tenders/:tenderId/matrix", () => HttpResponse.json([])),
    http.get("*/expediente/tenders/:tenderId/conflicts", () => HttpResponse.json([])),
  );
}

describe("AnalisisBasesPage", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("muestra requires_ocr de forma explícita para un documento sin capa de texto", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AnalisisBasesPage />);
    await user.click(await screen.findByRole("combobox", { name: "Convocatoria" }));
    await user.click(await screen.findByRole("option", { name: TENDER.title }));

    expect(await screen.findByText("bases.pdf")).toBeInTheDocument();
    expect(screen.getByText("Requiere OCR (no disponible en esta ronda)")).toBeInTheDocument();
  }, 20000);

  it("muestra el aviso de uso de IA (REQ-115)", async () => {
    renderWithProviders(<AnalisisBasesPage />);
    expect(await screen.findByText(/generado por IA|inteligencia artificial/i)).toBeInTheDocument();
  }, 20000);
});
