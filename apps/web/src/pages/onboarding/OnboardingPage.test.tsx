import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import type { MyOrg } from "@/lib/api/schemas";
import OnboardingPage from "@/pages/onboarding/OnboardingPage";

/**
 * Patrón Likida/atiende.ai #7: respuesta de `GET /onboarding/state`
 * derivada de las MISMAS variables mutables (`orgs`/`profile`) que ya usan
 * los demás handlers de cada mock de sesión -- refleja el progreso real
 * del wizard en cada momento, en vez de una respuesta fija que se
 * desincronizaría del resto de la simulación.
 */
function buildOnboardingState(orgs: MyOrg[], profile: Record<string, unknown> | null) {
  const legalName = (profile?.legalName as string | undefined) ?? null;
  const taxId = (profile?.taxId as string | undefined) ?? null;
  const sector = (profile?.sector as string | undefined) ?? null;
  const missingRequired: string[] = [];
  if (orgs.length === 0) missingRequired.push("organization");
  if (!legalName) missingRequired.push("legalName");
  if (!taxId) missingRequired.push("taxId");
  if (!sector) missingRequired.push("sector");
  const nextField = missingRequired[0] ?? null;
  const questionByField: Record<string, string> = {
    organization: "¿Cómo se llama tu organización?",
    legalName: "¿Cuál es la razón social completa de tu empresa?",
    taxId: "¿Cuál es tu RFC?",
    sector: "¿A qué giro o sector se dedica tu empresa?",
  };
  const nextActionByField: Record<string, { method: string; path: string; hint: string }> = {
    organization: { method: "POST", path: "/organizations", hint: "Crea la organización." },
    legalName: { method: "PUT", path: "/company/profile", hint: "Guarda el perfil." },
    taxId: { method: "PUT", path: "/company/profile", hint: "Guarda el perfil." },
    sector: { method: "PUT", path: "/company/profile", hint: "Guarda el perfil." },
  };
  return {
    orgId: orgs[0]?.id ?? null,
    hasOrganization: orgs.length > 0,
    legalName,
    taxId,
    sector,
    teamInvited: false,
    firstDocumentUploaded: false,
    missingRequired,
    missingOptional: ["team", "document"],
    isComplete: missingRequired.length === 0,
    nextField,
    question: nextField ? questionByField[nextField] : "Tu organización está lista.",
    questionSource: "canned" as const,
    nextAction: nextField ? nextActionByField[nextField] : null,
  };
}

function mockNewAccountSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  let orgs: MyOrg[] = [];

  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json(orgs)),
    http.post("*/organizations", async ({ request }) => {
      const body = (await request.json()) as { name: string; slug: string };
      orgs = [{ id: "org-new", name: body.name, slug: body.slug, role: "owner" }];
      return HttpResponse.json({ id: "org-new", name: body.name, slug: body.slug }, { status: 201 });
    }),
    http.get("*/company/profile", () => HttpResponse.json(null)),
    http.put("*/company/profile", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        id: "profile-1",
        legalName: body.legalName,
        tradeName: null,
        taxId: body.taxId,
        description: null,
        sector: body.sector ?? null,
        foundedYear: null,
        employeeCount: null,
        annualRevenue: null,
        website: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    }),
    http.get("*/onboarding/state", () => HttpResponse.json(buildOnboardingState(orgs, null))),
  );
}

function mockExistingOrgSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  const orgs: MyOrg[] = [{ id: "org-a", name: "Mi Empresa S.A. de C.V.", slug: "mi-empresa", role: "owner" }];
  let profile: Record<string, unknown> | null = null;

  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json(orgs)),
    http.get("*/company/profile", () => HttpResponse.json(profile)),
    http.put("*/company/profile", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      profile = {
        id: "profile-1",
        legalName: body.legalName,
        tradeName: null,
        taxId: body.taxId,
        description: null,
        sector: body.sector ?? null,
        foundedYear: null,
        employeeCount: null,
        annualRevenue: null,
        website: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      return HttpResponse.json(profile);
    }),
    http.get("*/onboarding/state", () => HttpResponse.json(buildOnboardingState(orgs, profile))),
  );
}

describe("OnboardingPage", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  /**
   * WB-10 (docs/auditoria-2/web-r7-r8a.md §4): antes de este cambio, el
   * paso vivía solo en `useState` -- desmontar y volver a montar el
   * componente (lo que una recarga real de la pestaña hace) siempre volvía
   * al paso 2 (perfil), incluso si el usuario ya había avanzado a un paso
   * OPCIONAL (aquí: "Invita a tu equipo", paso 3 → omitido → paso 4). Se
   * simula la recarga con un `unmount()`/render real (no solo re-render),
   * que es lo único que puede reproducir la pérdida de `useState`.
   */
  it("sobrevive una recarga real de la página: no reinicia en el paso 2 tras avanzar a un paso opcional", async () => {
    mockExistingOrgSession();
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<OnboardingPage />);

    await screen.findByRole("heading", { level: 2, name: "Perfil de empresa esencial" });
    await user.type(screen.getByLabelText("Razón social"), "Mi Empresa S.A. de C.V.");
    await user.type(screen.getByLabelText("RFC"), "MEE800101ABC");
    await user.click(screen.getByRole("button", { name: "Guardar y continuar" }));

    await screen.findByRole("heading", { level: 2, name: "Invita a tu equipo" });
    await user.click(screen.getByRole("button", { name: "Omitir por ahora" }));
    await screen.findByRole("heading", { level: 2, name: "Sube tu primer documento" });
    expect(sessionStorage.getItem("atiende.onboarding.step")).toBe("4");

    // Recarga real de la pestaña: desmonta y vuelve a montar (una
    // rerenderización normal NUNCA habría reproducido la pérdida de
    // `useState` que describe WB-10).
    unmount();

    mockExistingOrgSession();
    renderWithProviders(<OnboardingPage />);
    expect(await screen.findByRole("heading", { level: 2, name: "Sube tu primer documento" })).toBeInTheDocument();
  }, 20000);


  it("empieza en el paso 'Organización' cuando la cuenta todavía no tiene ninguna", async () => {
    mockNewAccountSession();
    renderWithProviders(<OnboardingPage />);
    expect(await screen.findByRole("heading", { level: 2, name: "Crea tu organización" })).toBeInTheDocument();
  });

  it("crea la organización y avanza al paso de perfil de empresa", async () => {
    mockNewAccountSession();
    const user = userEvent.setup();
    renderWithProviders(<OnboardingPage />);

    await user.type(await screen.findByLabelText("Nombre de la organización"), "Mi Empresa S.A. de C.V.");
    await user.click(screen.getByRole("button", { name: "Crear organización y continuar" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Perfil de empresa esencial" })).toBeInTheDocument();
  }, 15000);

  it("guarda el perfil esencial y avanza al paso de invitar equipo", async () => {
    mockNewAccountSession();
    const user = userEvent.setup();
    renderWithProviders(<OnboardingPage />);

    await user.type(await screen.findByLabelText("Nombre de la organización"), "Mi Empresa S.A. de C.V.");
    await user.click(screen.getByRole("button", { name: "Crear organización y continuar" }));

    await screen.findByRole("heading", { level: 2, name: "Perfil de empresa esencial" });
    await user.type(screen.getByLabelText("Razón social"), "Mi Empresa S.A. de C.V.");
    await user.type(screen.getByLabelText("RFC"), "MEE800101ABC");
    await user.click(screen.getByRole("button", { name: "Guardar y continuar" }));

    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Invita a tu equipo" })).toBeInTheDocument());
  }, 20000);

  it("no tiene violaciones de accesibilidad detectables por axe en el paso inicial", async () => {
    mockNewAccountSession();
    renderWithProviders(<OnboardingPage />);
    await screen.findByRole("heading", { level: 2, name: "Crea tu organización" });
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  }, 15000);

  /**
   * Patrón Likida/atiende.ai #7: la tira conversacional (`OnboardingAssistant`)
   * muestra la pregunta que devuelve `GET /onboarding/state` -- SOLO
   * complementa al wizard (que sigue siendo la forma real de capturar cada
   * dato), nunca lo reemplaza ni bloquea su envío.
   */
  it("la tira conversacional muestra la pregunta del backend y el checklist de campos obligatorios", async () => {
    mockNewAccountSession();
    renderWithProviders(<OnboardingPage />);

    const assistant = await screen.findByTestId("onboarding-assistant");
    expect(await screen.findByText("¿Cómo se llama tu organización?")).toBeInTheDocument();
    // Ninguno de los 4 campos obligatorios está marcado todavía.
    expect(assistant).toHaveTextContent("Organización");
    expect(assistant).toHaveTextContent("Razón social");
    expect(assistant).toHaveTextContent("RFC");
    expect(assistant).toHaveTextContent("Giro");
  }, 15000);

  it("la tira conversacional avanza de pregunta según el progreso ya guardado (organización con perfil vacío)", async () => {
    mockExistingOrgSession();
    renderWithProviders(<OnboardingPage />);

    expect(await screen.findByText("¿Cuál es la razón social completa de tu empresa?")).toBeInTheDocument();
  }, 15000);
});
