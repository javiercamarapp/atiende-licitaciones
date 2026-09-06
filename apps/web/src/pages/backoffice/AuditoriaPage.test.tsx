import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

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
});
