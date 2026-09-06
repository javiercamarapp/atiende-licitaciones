import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import PaqueteDescargablePage from "@/pages/entrega/PaqueteDescargablePage";

const TENDER = { id: "tender-1", title: "Convocatoria de prueba", source: "test", externalId: "ext-1", contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", submissionDeadline: null, publishedAt: null, url: null, status: "in_progress", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    http.get("*/tenders", () => HttpResponse.json({ items: [TENDER], nextCursor: null })),
  );
}

describe("PaqueteDescargablePage", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("muestra el estado vacío honesto hasta seleccionar una convocatoria con paquete", async () => {
    renderWithProviders(<PaqueteDescargablePage />);
    expect(await screen.findByText("La presentación y firma las realiza el usuario")).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Convocatoria" })).toBeInTheDocument();
  }, 20000);

  it("nunca muestra 'Listo para presentar' cuando el servidor deriva 'draft' (A14)", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/expediente/tenders/:tenderId/package/latest", () =>
        HttpResponse.json({
          id: "proposal-1",
          status: "draft",
          draftReasons: ["Checklist no está en verde"],
          missing: ["Falta la sección económica"],
          generatedAt: "2026-01-02T00:00:00Z",
          notice: "El sistema nunca presenta ni firma nada.",
        }),
      ),
    );
    renderWithProviders(<PaqueteDescargablePage />);
    await user.click(await screen.findByRole("combobox", { name: "Convocatoria" }));
    await user.click(await screen.findByRole("option", { name: TENDER.title }));

    expect(await screen.findByText("Borrador")).toBeInTheDocument();
    expect(screen.queryByText("Listo para presentar")).not.toBeInTheDocument();
    expect(screen.getByText("Checklist no está en verde")).toBeInTheDocument();
    // Timeout propio (ver docs/logs/fix-web-coverage.log y el comentario en
    // vite.config.ts): abrir este <Select/> real de Radix como primera
    // acción paga, bajo `--coverage`, un costo medido de ~17-20s en
    // aislamiento total -- no es un bug de esta prueba. 45s deja ~2x de
    // margen sobre ese costo medido.
  }, 45000);

  it("muestra 'Listo para presentar' solo cuando el servidor deriva 'ready'", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/expediente/tenders/:tenderId/package/latest", () =>
        HttpResponse.json({
          id: "proposal-1",
          status: "ready",
          draftReasons: [],
          missing: [],
          generatedAt: "2026-01-02T00:00:00Z",
          notice: "El sistema nunca presenta ni firma nada.",
        }),
      ),
    );
    renderWithProviders(<PaqueteDescargablePage />);
    await user.click(await screen.findByRole("combobox", { name: "Convocatoria" }));
    await user.click(await screen.findByRole("option", { name: TENDER.title }));

    await waitFor(() => expect(screen.getByText("Listo para presentar")).toBeInTheDocument());
    // Timeout propio: ver comentario arriba y en vite.config.ts.
  }, 45000);
});
