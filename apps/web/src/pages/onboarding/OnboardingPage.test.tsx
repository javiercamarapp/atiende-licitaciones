import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import type { MyOrg } from "@/lib/api/schemas";
import OnboardingPage from "@/pages/onboarding/OnboardingPage";

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
  );
}

describe("OnboardingPage", () => {
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
});
