import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import SeguimientoPage from "@/pages/entrega/SeguimientoPage";

const TENDER = { id: "tender-1", title: "Convocatoria de prueba", source: "test", externalId: "ext-1", contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", submissionDeadline: null, publishedAt: null, url: null, status: "in_progress", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    http.get("*/tenders", () => HttpResponse.json({ items: [TENDER], nextCursor: null })),
    http.get("*/expediente/tenders/:tenderId/post-award", () =>
      HttpResponse.json([
        {
          id: "pa-1",
          tenderId: TENDER.id,
          kind: "pago",
          label: "Pago de factura 001",
          dueDate: "2026-02-01",
          status: "pending",
          amount: 15000,
          notes: null,
          legalReference: "LAASSP Art. 73",
          reminderLeadDays: 3,
          jobId: "job-1",
          createdAt: "2026-01-10T00:00:00Z",
          calendarNote: "Calendario de días hábiles: solo excluye sábados y domingos (sin calendario oficial de días inhábiles).",
          legalRegime: { law: "LAASSP", article: "Art. 73", dofDate: "2025-04-16", effectiveDate: "2025-04-17", unit: "dias_habiles", days: 17, reason: "Régimen vigente" },
        },
      ]),
    ),
  );
}

describe("SeguimientoPage", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("muestra calendarNote y legalRegime reales para un seguimiento de tipo pago", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SeguimientoPage />);
    await user.click(await screen.findByRole("combobox", { name: "Convocatoria" }));
    await user.click(await screen.findByRole("option", { name: TENDER.title }));

    expect(await screen.findByText(/Calendario de días hábiles/)).toBeInTheDocument();
    expect(screen.getByText(/Régimen legal: LAASSP Art. 73/)).toBeInTheDocument();
  }, 20000);
});
