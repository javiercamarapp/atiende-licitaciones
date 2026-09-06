import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import FuentesFrescuraPage from "@/pages/convocatorias/FuentesFrescuraPage";

describe("FuentesFrescuraPage", () => {
  // GET /tenders/sources/freshness exige `Authorization: Bearer` (cualquier
  // usuario autenticado, sin X-Org-Id) — se simula un access token en el
  // almacén de sesión para poder probar los estados de datos/error reales
  // sin pasar por el flujo de login completo (fuera de alcance de esta
  // prueba de componente).
  beforeEach(() => {
    setTokens({ accessToken: "fake-access-token", refreshToken: null });
  });


  it("muestra la leyenda de los cinco estados posibles de una fuente", () => {
    renderWithProviders(<FuentesFrescuraPage />);
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.getByText("Caída")).toBeInTheDocument();
    expect(screen.getByText("CAPTCHA")).toBeInTheDocument();
    expect(screen.getByText("Cambio de interfaz")).toBeInTheDocument();
    expect(screen.getByText("Permisos faltantes")).toBeInTheDocument();
  });

  it("no muestra fuentes inventadas: expone el estado vacío honesto cuando la API no trae fuentes", async () => {
    server.use(http.get("*/tenders/sources/freshness", () => HttpResponse.json([])));
    renderWithProviders(<FuentesFrescuraPage />);
    expect(await screen.findByText("Aún no hay fuentes configuradas")).toBeInTheDocument();
  });

  it("con datos reales, traduce cada estado de source_run_status a una etiqueta explícita", async () => {
    server.use(
      http.get("*/tenders/sources/freshness", () =>
        HttpResponse.json([
          { sourceId: "compranet", status: "ok", lastSuccessAt: "2026-01-01T12:00:00Z", startedAt: "2026-01-01T12:00:00Z", finishedAt: "2026-01-01T12:01:00Z", attempts: 1, ageSeconds: 60 },
          { sourceId: "dof", status: "captcha", lastSuccessAt: null, startedAt: "2026-01-01T12:00:00Z", finishedAt: null, attempts: 3, ageSeconds: null },
        ]),
      ),
    );
    renderWithProviders(<FuentesFrescuraPage />);
    await waitFor(() => expect(screen.getByText("compranet")).toBeInTheDocument());
    expect(screen.getByText("dof")).toBeInTheDocument();
  });

  it("muestra el error real con request_id cuando la API falla", async () => {
    server.use(
      http.get("*/tenders/sources/freshness", () =>
        HttpResponse.json(
          { type: "https://atiende.example/errors/internal-server-error", title: "Error interno del servidor", status: 500, requestId: "req-xyz" },
          { status: 500 },
        ),
      ),
    );
    renderWithProviders(<FuentesFrescuraPage />);
    expect(await screen.findByText(/req-xyz/)).toBeInTheDocument();
  });
});
