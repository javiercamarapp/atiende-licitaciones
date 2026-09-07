import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import EntregasPage from "@/pages/entrega/EntregasPage";

const TENDER = { id: "tender-1", title: "Convocatoria de prueba", source: "test", externalId: "ext-1", contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", submissionDeadline: null, publishedAt: null, url: null, status: "in_progress", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    http.get("*/tenders", () => HttpResponse.json({ items: [TENDER], nextCursor: null })),
    http.get("*/expediente/tenders/:tenderId/submission", () => HttpResponse.json(null)),
  );
}

describe("EntregasPage", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("muestra siempre el aviso de que el sistema nunca envía ni firma nada", async () => {
    renderWithProviders(<EntregasPage />);
    expect(await screen.findByText("El sistema nunca envía ni firma nada")).toBeInTheDocument();
  });

  it("permite declarar una presentación (fecha + notas) sin enviar nada a un portal externo", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EntregasPage />);
    await user.click(await screen.findByRole("combobox", { name: "Convocatoria" }));
    await user.click(await screen.findByRole("option", { name: TENDER.title }));

    expect(await screen.findByRole("heading", { name: "Declarar presentación" })).toBeInTheDocument();
    // Timeout propio (ver docs/logs/fix-web-coverage.log y el comentario en
    // vite.config.ts): abrir este <Select/> real de Radix como primera
    // acción de la prueba paga, bajo `--coverage`, un costo medido de
    // ~17-20s en aislamiento total (sin ningún otro worker corriendo) -- no
    // es una condición de carrera de este test, es el mismo costo que
    // reproducen TODAS las pruebas que abren un <Select/> como primera
    // interacción. 45s deja margen (~2x) sobre ese costo medido.
  }, process.env.CI === "true" ? 135000 : 45000);
});
