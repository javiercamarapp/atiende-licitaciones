import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import UsuariosRolesPage from "@/pages/backoffice/UsuariosRolesPage";

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    http.get("*/organizations/org-a/memberships", () =>
      HttpResponse.json({
        items: [
          { userId: "user-1", email: "admin@empresa.com", fullName: "Admin", role: "owner", status: "active", joinedAt: "2026-01-01T00:00:00Z" },
          { userId: "user-2", email: "writer@empresa.com", fullName: "Writer", role: "writer", status: "active", joinedAt: "2026-01-02T00:00:00Z" },
        ],
        nextCursor: null,
      }),
    ),
  );
}

describe("UsuariosRolesPage", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("lista los miembros reales de la organización activa (cierra el gap histórico de GET /organizations/memberships)", async () => {
    renderWithProviders(<UsuariosRolesPage />);
    expect(await screen.findByText("writer@empresa.com")).toBeInTheDocument();
    expect(screen.getByText("admin@empresa.com")).toBeInTheDocument();
  }, 15000);

  it("no permite eliminarse a uno mismo desde la tabla", async () => {
    renderWithProviders(<UsuariosRolesPage />);
    await screen.findByText("admin@empresa.com");
    expect(screen.getByRole("button", { name: "Eliminar a admin@empresa.com" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Eliminar a writer@empresa.com" })).toBeEnabled();
  }, 15000);
});
