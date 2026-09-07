import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import JobsPage from "@/pages/backoffice/JobsPage";

const QUEUED_JOB = {
  id: "job-1",
  orgId: "org-a",
  kind: "discover_tenders",
  status: "queued",
  attempts: 0,
  maxAttempts: 5,
  lastError: null,
  nextRunAt: "2026-01-05T00:00:00Z",
  createdAt: "2026-01-05T00:00:00Z",
};

function mockAuthenticatedSuperadmin() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
  );
}

/**
 * REQ-193 (continuación): "Sin jobs para este filtro" no ofrecía ninguna
 * salida cuando el filtro de estado dejaba la lista vacía -- el usuario solo
 * podía adivinar que debía volver a abrir el <Select/> y elegir "Todos los
 * estados" a mano. Con un filtro real ya activo, el botón "Ver todos los
 * estados" lo hace explícito; con el filtro por defecto ("todos") ya vacío,
 * no hay ninguna acción honesta que ofrecer y el botón no aparece.
 */
describe("JobsPage (REQ-193: EmptyState con guía de siguiente acción)", () => {
  beforeEach(() => {
    mockAuthenticatedSuperadmin();
  });

  it("sin filtro activo, la lista vacía no ofrece ninguna acción (no hay filtro que limpiar)", async () => {
    server.use(http.get("*/admin/jobs", () => HttpResponse.json([])));

    renderWithProviders(<JobsPage />);

    await waitFor(() => expect(screen.getByText("Sin jobs para este filtro")).toBeInTheDocument(), { timeout: 8000, interval: 100 });
    expect(screen.queryByRole("button", { name: "Ver todos los estados" })).not.toBeInTheDocument();
  }, 15000);

  it("con un filtro de estado activo y lista vacía, ofrece volver a 'Todos los estados' y lo hace real", async () => {
    const user = userEvent.setup();
    const seenQueries: string[] = [];
    server.use(
      http.get("*/admin/jobs", ({ request }) => {
        const url = new URL(request.url);
        const status = url.searchParams.get("status") ?? "todos";
        seenQueries.push(status);
        return HttpResponse.json(status === "failed" ? [] : [QUEUED_JOB]);
      }),
    );

    renderWithProviders(<JobsPage />);
    await waitFor(() => expect(screen.getByText("discover_tenders")).toBeInTheDocument(), { timeout: 10000, interval: 100 });

    await user.click(screen.getByRole("combobox", { name: "Filtrar por estado" }));
    await user.click(await screen.findByRole("option", { name: "failed" }));

    await waitFor(() => expect(screen.getByText("Sin jobs para este filtro")).toBeInTheDocument(), { timeout: 10000, interval: 100 });
    const actionButton = screen.getByRole("button", { name: "Ver todos los estados" });

    await user.click(actionButton);

    await waitFor(() => expect(screen.getByText("discover_tenders")).toBeInTheDocument(), { timeout: 10000, interval: 100 });
    expect(screen.queryByRole("button", { name: "Ver todos los estados" })).not.toBeInTheDocument();
    expect(seenQueries).toContain("failed");
    // Timeout propio (ver docs/logs/fix-web-coverage.log y el comentario en
    // vite.config.ts): abrir este <Select/> real de Radix como primera
    // acción del archivo paga, bajo `--coverage`, un costo medido de
    // ~10-30s en aislamiento total -- no es un bug de esta prueba. 45s deja
    // margen sobre ese costo medido (mismo patrón que RedaccionPage.test.tsx).
  }, 45000);
});
