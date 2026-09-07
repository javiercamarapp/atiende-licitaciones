import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import RevisionPage from "@/pages/preparacion/RevisionPage";

const TENDER = { id: "tender-1", title: "Convocatoria de prueba", source: "test", externalId: "ext-1", contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", submissionDeadline: null, publishedAt: null, url: null, status: "in_progress", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

function mockSession(role: string) {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "writer@empresa.com", fullName: "Writer" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role }])),
    http.get("*/tenders", () => HttpResponse.json({ items: [TENDER], nextCursor: null })),
    http.get("*/expediente/tenders/:tenderId/approval", () =>
      HttpResponse.json({
        state: "en_revision",
        approvals: [{ scope: "expediente", scopeRef: "expediente", approvedBy: null, approvedByRole: "reviewer", approvedAt: "2026-01-01T00:00:00Z", inputsHash: "abc", status: "invalidada" }],
        comments: [{ scopeRef: "expediente", authorId: "user-2", authorRole: "reviewer", text: "Falta corregir el anexo 3.", createdAt: "2026-01-02T00:00:00Z" }],
        currentInputsHash: "def456",
        fullyApproved: false,
      }),
    ),
  );
}

describe("RevisionPage", () => {
  beforeEach(() => {
    mockSession("writer");
  });

  it("A12: un rol indebido (writer) no puede aprobar -- el botón de aprobar no se ofrece", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RevisionPage />);
    await user.click(await screen.findByRole("combobox", { name: "Convocatoria" }));
    await user.click(await screen.findByRole("option", { name: TENDER.title }));

    expect(await screen.findByText(/no puede aprobar/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aprobar expediente" })).not.toBeInTheDocument();
    // Timeout propio (ver docs/logs/fix-web-coverage.log y el comentario en
    // vite.config.ts): abrir este <Select/> real de Radix como primera
    // acción paga, bajo `--coverage`, un costo medido de ~17-20s en
    // aislamiento total -- no es un bug de esta prueba. 45s deja ~2x de
    // margen sobre ese costo medido.
  }, process.env.CI === "true" ? 135000 : 45000);

  it("muestra una aprobación invalidada tras un cambio (A11)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RevisionPage />);
    await user.click(await screen.findByRole("combobox", { name: "Convocatoria" }));
    await user.click(await screen.findByRole("option", { name: TENDER.title }));

    expect(await screen.findByText("Invalidada tras un cambio")).toBeInTheDocument();
    // Timeout propio: ver comentario arriba y en vite.config.ts.
  }, process.env.CI === "true" ? 135000 : 45000);

  // R5-09 (reverificación api ronda 5): antes de esta ronda, `POST
  // /auth/2fa/step-up` no declaraba ni la organización activa ni el
  // propósito de la acción -- ver el mismo hallazgo cubierto en
  // TarifasAprobadasPage.test.tsx.
  it("admin pide el step-up con la organización activa (X-Org-Id) y el propósito exacto de la acción (R5-09)", async () => {
    mockSession("admin");
    server.use(
      http.get("*/expediente/tenders/:tenderId/approval", () =>
        HttpResponse.json({
          state: "en_revision",
          approvals: [],
          comments: [],
          currentInputsHash: "def456",
          fullyApproved: false,
        }),
      ),
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })),
    );

    let capturedOrgIdHeader: string | null = null;
    let capturedBody: unknown;
    let capturedStepUpHeader: string | null = null;
    server.use(
      http.post("*/auth/2fa/step-up", async ({ request }) => {
        capturedOrgIdHeader = request.headers.get("x-org-id");
        capturedBody = await request.json();
        return HttpResponse.json({ stepUpToken: "step-up-1", expiresAt: "2026-01-01T00:10:00Z" });
      }),
      http.post("*/expediente/tenders/:tenderId/approval/approve", ({ request }) => {
        capturedStepUpHeader = request.headers.get("x-step-up");
        return HttpResponse.json({
          state: "aprobado",
          approvals: [],
          comments: [],
          currentInputsHash: "def456",
          fullyApproved: true,
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<RevisionPage />);
    await user.click(await screen.findByRole("combobox", { name: "Convocatoria" }));
    await user.click(await screen.findByRole("option", { name: TENDER.title }));

    await user.click(await screen.findByRole("button", { name: "Aprobar expediente" }));
    await user.type(await screen.findByLabelText("Código TOTP o de respaldo", {}, { timeout: 10000 }), "123456");
    await user.click(screen.getByRole("button", { name: "Verificar y continuar" }));

    await waitFor(() => expect(capturedBody).toBeDefined());
    expect(capturedOrgIdHeader).toBe("org-a");
    expect(capturedBody).toEqual({ code: "123456", purpose: "expediente.approval" });
    await waitFor(() => expect(capturedStepUpHeader).toBe("step-up-1"));
    // Timeout propio, más generoso que el resto de este archivo (ver
    // docs/logs/fix-web-coverage.log y el comentario en vite.config.ts):
    // esta prueba abre DOS superficies Radix con efectos pasivos (el
    // <Select/> de convocatoria y el diálogo de step-up), cada una capaz de
    // pagar el costo de ~17-30s medido en aislamiento -- 60s cubre el caso
    // en que ambas lo paguen.
  }, process.env.CI === "true" ? 180000 : 60000);
});
