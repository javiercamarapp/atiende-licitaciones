import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import AuditoriaPage from "@/pages/backoffice/AuditoriaPage";

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    http.get("*/audit-log", () =>
      HttpResponse.json({
        items: [
          { id: "evt-1", orgId: "org-a", actorId: "user-1", action: "tender_document.upload", entity: "tender_documents", entityId: "doc-1", before: null, after: null, requestId: "req-abc", createdAt: "2026-01-05T00:00:00Z" },
        ],
        nextCursor: null,
      }),
    ),
  );
}

describe("AuditoriaPage", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("muestra eventos reales de la bitácora de la organización activa (cierra el gap histórico de GET /audit-log)", async () => {
    renderWithProviders(<AuditoriaPage />);
    expect(await screen.findByText("tender_document.upload")).toBeInTheDocument();
    expect(screen.getByText("req-abc")).toBeInTheDocument();
  }, 15000);

  it("muestra un 403 real tal cual (rol sin permiso) en vez de ocultar la pantalla", async () => {
    server.use(
      http.get("*/audit-log", () =>
        HttpResponse.json({ type: "forbidden", title: "Solo reviewer/admin/owner pueden leer la bitácora", status: 403, requestId: "req-403" }, { status: 403 }),
      ),
    );
    renderWithProviders(<AuditoriaPage />);
    expect(await screen.findByText(/Solo reviewer\/admin\/owner/)).toBeInTheDocument();
  }, 15000);

  /**
   * REQ-193 (continuación): "Sin eventos" no ofrecía salida cuando el
   * filtro (entidad y/o traza) dejaba la bitácora vacía. Sin ningún filtro
   * activo no hay ninguna acción honesta que ofrecer (no aparece botón);
   * con un filtro de entidad activo, "Limpiar filtros" lo hace real: limpia
   * tanto `entity` como `correlationId` y dispara de nuevo la consulta sin
   * filtro.
   */
  it("sin filtro activo, la bitácora vacía no ofrece ninguna acción", async () => {
    server.use(http.get("*/audit-log", () => HttpResponse.json({ items: [], nextCursor: null })));
    renderWithProviders(<AuditoriaPage />);

    await waitFor(() => expect(screen.getByText("Sin eventos")).toBeInTheDocument(), { timeout: 8000, interval: 100 });
    expect(screen.queryByRole("button", { name: "Limpiar filtros" })).not.toBeInTheDocument();
  }, 15000);

  it("con un filtro de entidad activo y sin resultados, 'Limpiar filtros' lo quita y vuelve a mostrar la bitácora completa", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/audit-log", ({ request }) => {
        const url = new URL(request.url);
        const entity = url.searchParams.get("entity");
        if (entity) return HttpResponse.json({ items: [], nextCursor: null });
        return HttpResponse.json({
          items: [
            { id: "evt-1", orgId: "org-a", actorId: "user-1", action: "tender_document.upload", entity: "tender_documents", entityId: "doc-1", before: null, after: null, requestId: "req-abc", createdAt: "2026-01-05T00:00:00Z" },
          ],
          nextCursor: null,
        });
      }),
    );

    renderWithProviders(<AuditoriaPage />);
    await waitFor(() => expect(screen.getByText("tender_document.upload")).toBeInTheDocument(), { timeout: 8000, interval: 100 });

    await user.type(screen.getByLabelText("Filtrar por entidad"), "entidad_sin_eventos");
    await waitFor(() => expect(screen.getByText("Sin eventos")).toBeInTheDocument(), { timeout: 8000, interval: 100 });

    const clearButton = screen.getByRole("button", { name: "Limpiar filtros" });
    await user.click(clearButton);

    await waitFor(() => expect(screen.getByLabelText("Filtrar por entidad")).toHaveValue(""), { timeout: 8000, interval: 100 });
    await waitFor(() => expect(screen.getByText("tender_document.upload")).toBeInTheDocument(), { timeout: 8000, interval: 100 });
  }, 15000);
});
