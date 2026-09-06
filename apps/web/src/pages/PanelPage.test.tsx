import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import PanelPage from "@/pages/PanelPage";

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
  );
}

const tender = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "tender-1",
  source: "compranet",
  externalId: "ext-1",
  title: "Convocatoria de prueba",
  contractingBody: "Dependencia",
  cpvCodes: [],
  budgetAmount: 100000,
  currency: "MXN",
  submissionDeadline: isoDaysAgo(-10),
  publishedAt: isoDaysAgo(3),
  url: null,
  status: "discovered",
  createdAt: isoDaysAgo(3),
  updatedAt: isoDaysAgo(3),
  ...overrides,
});

function mockDashboardData() {
  server.use(
    // "*/matching/tenders" DEBE registrarse antes que "*/tenders*": MSW
    // resuelve el primer handler cuyo patrón haga match, y "/matching/tenders"
    // también cumple el patrón genérico "*/tenders*" (termina en "/tenders")
    // -- si el genérico fuera primero, se comería por accidente la petición
    // de matching (reproducido en vivo: matchesTotal quedaba en 0).
    http.get("*/matching/tenders", () =>
      HttpResponse.json({
        items: [
          { tenderId: "t1", tenderKey: "ext-1", relevance: { score: 80, criteria: [] }, eligibility: { status: "cumple", criteria: [] }, missingProfileFields: [] },
          { tenderId: "t2", tenderKey: "ext-2", relevance: { score: 30, criteria: [] }, eligibility: { status: "no_cumple", criteria: [] }, missingProfileFields: [] },
        ],
      }),
    ),
    http.get("*/tenders*", () =>
      HttpResponse.json({
        items: [
          tender({ id: "t1", createdAt: isoDaysAgo(1) }),
          tender({ id: "t2", createdAt: isoDaysAgo(2), status: "in_progress" }),
          tender({ id: "t3", createdAt: isoDaysAgo(45), status: "won" }),
        ],
        nextCursor: null,
      }),
    ),
    http.get("*/company/rates", () =>
      HttpResponse.json([{ id: "r1", itemCode: "A", description: "d", unit: null, unitPrice: 1, currency: "MXN", status: "draft", createdAt: isoDaysAgo(1), updatedAt: isoDaysAgo(1) }]),
    ),
    http.get("*/expediente/post-award-alerts", () =>
      HttpResponse.json([
        {
          id: "f1",
          tenderId: "t3",
          kind: "pago",
          label: "Pago pendiente",
          dueDate: isoDaysAgo(-2),
          status: "pending",
          amount: 1000,
          notes: null,
          legalReference: null,
          reminderLeadDays: 5,
          jobId: null,
          createdAt: isoDaysAgo(1),
          calendarNote: null,
          legalRegime: null,
          alertLevel: "proximo",
        },
      ]),
    ),
    http.get("*/audit-log*", () => HttpResponse.json({ items: [], nextCursor: null })),
    http.get("*/company/profile", () => HttpResponse.json(null)),
    http.get("*/company/documents", () => HttpResponse.json([])),
    http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: false, enrolledAt: null })),
  );
}

describe("PanelPage", () => {
  it("muestra KPIs reales calculados a partir de convocatorias, matching, tarifas y alertas", async () => {
    mockAuthenticatedSession();
    mockDashboardData();

    renderWithProviders(<PanelPage />);

    const newTendersLabel = await screen.findByText("Convocatorias nuevas (7 días)");
    // t1 (1 día) y t2 (2 días) caen dentro de 7 días; t3 (45 días) no --
    // scoped a la tarjeta de este KPI (no un `getByText` global: "2" también
    // aparece como valor de otras tarjetas). `waitFor` porque el valor
    // arranca como skeleton (dashboard.isLoading) hasta que las cuatro
    // queries que alimentan useDashboard() resuelven.
    await waitFor(() => expect(within(newTendersLabel.parentElement as HTMLElement).getByText("2")).toBeInTheDocument());
    expect(await screen.findByText("1 / 2")).toBeInTheDocument(); // matches elegibles
  });

  it("muestra el checklist de activación con pasos pendientes reales", async () => {
    mockAuthenticatedSession();
    mockDashboardData();

    renderWithProviders(<PanelPage />);

    expect(await screen.findByText("Checklist de activación")).toBeInTheDocument();
    expect(await screen.findByText("Perfil de empresa completo (razón social y RFC)")).toBeInTheDocument();
  });

  it("muestra un error honesto (con request_id) si el audit-log responde 403", async () => {
    mockAuthenticatedSession();
    mockDashboardData();
    server.use(
      http.get("*/audit-log*", () =>
        HttpResponse.json({ type: "https://atiende.example/errors/forbidden", title: "No tienes permiso para ver esta bitácora", status: 403, requestId: "req-9" }, { status: 403 }),
      ),
    );

    renderWithProviders(<PanelPage />);

    expect(await screen.findByText(/No tienes permiso para ver esta bitácora/)).toBeInTheDocument();
    expect(screen.getByText(/req-9/)).toBeInTheDocument();
  });
});
// Nota: sin prueba de axe(document.body) aquí a propósito -- PanelPage
// depende de <AppShell/> para su landmark <main> real (ver App.tsx), igual
// que el resto de páginas de módulo (ConfiguracionPage, PerfilCapacidadesPage,
// etc., ninguna con axe unitario propio). Renderizarla sola sin esa shell
// produce el falso positivo "region" de axe-core (contenido no envuelto en
// un landmark) -- la accesibilidad de la pantalla COMPLETA (con AppShell) la
// cubre la suite E2E real (e2e/dashboard.spec.ts).
