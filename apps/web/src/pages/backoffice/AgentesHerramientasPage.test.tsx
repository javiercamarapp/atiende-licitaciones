import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import { Toaster } from "@/components/ui/sonner";
import AgentesHerramientasPage from "@/pages/backoffice/AgentesHerramientasPage";

const PENDING_TOOL_CALL = {
  id: "tc-1",
  agentRunId: "run-1",
  toolName: "enviar_correo",
  authorizationStatus: "pending" as const,
  status: null,
  approvedBy: null,
  approvedAt: null,
  createdAt: "2026-01-05T00:00:00Z",
};

/**
 * RF-01 (docs/auditoria-2/ronda5-final.md): apps/api exige `X-Step-Up`
 * (`purpose: "tool_call.approval"`) para aprobar/denegar una tool_call --
 * `apps/web` nunca lo declaraba, así que ambos botones siempre fallaban con
 * 403 en cuanto existía una tool_call pendiente real. Mismo patrón de
 * pruebas que TarifasAprobadasPage.test.tsx (WI-04, ronda 5).
 */
function mockAuthenticatedSessionWithOrgAdmin() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })),
    http.post("*/auth/2fa/step-up", () => HttpResponse.json({ stepUpToken: "step-up-1", expiresAt: "2026-01-01T00:10:00Z" })),
    http.get("*/agents/runs", () => HttpResponse.json([])),
    http.get("*/agents/tool-calls", () => HttpResponse.json([PENDING_TOOL_CALL])),
  );
}

async function approveViaStepUp(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Aprobar" }));
  await user.type(await screen.findByLabelText("Código TOTP o de respaldo", {}, { timeout: 10000 }), "123456");
  await user.click(screen.getByRole("button", { name: "Verificar y continuar" }));
}

describe("AgentesHerramientasPage (RF-01: step-up 2FA en aprobar/denegar tool_calls)", () => {
  beforeEach(() => {
    mockAuthenticatedSessionWithOrgAdmin();
  });

  /**
   * REQ-193: el EmptyState de "Corridas de agentes" no debe prometer una
   * acción de "configurar" un agente que no existe en ninguna pantalla de
   * esta app -- se corrigió la copia (antes: "Aún no hay agentes
   * configurados") en vez de fabricar un botón que no dispararía nada real.
   */
  it("sin corridas, el EmptyState de agentes es honesto y no ofrece ninguna acción inexistente", async () => {
    server.use(http.get("*/agents/runs", () => HttpResponse.json([])));

    renderWithProviders(<AgentesHerramientasPage />);

    const emptyState = await screen.findByText("Aún no hay corridas de agentes");
    expect(emptyState).toBeInTheDocument();
    expect(screen.queryByText("Aún no hay agentes configurados")).not.toBeInTheDocument();

    const statusContainer = emptyState.closest('[role="status"]');
    expect(statusContainer).not.toBeNull();
    if (statusContainer) {
      expect(within(statusContainer as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
    }
  });

  it("pide el step-up (X-Org-Id + purpose exacto) y envía X-Step-Up real al aprobar", async () => {
    const user = userEvent.setup();
    let capturedOrgIdHeader: string | null = null;
    let capturedBody: unknown;
    let capturedStepUpHeader: string | null = null;
    server.use(
      http.post("*/auth/2fa/step-up", async ({ request }) => {
        capturedOrgIdHeader = request.headers.get("x-org-id");
        capturedBody = await request.json();
        return HttpResponse.json({ stepUpToken: "step-up-1", expiresAt: "2026-01-01T00:10:00Z" });
      }),
      http.post("*/agents/tool-calls/:id/approve", ({ request }) => {
        capturedStepUpHeader = request.headers.get("x-step-up");
        return HttpResponse.json({ ...PENDING_TOOL_CALL, authorizationStatus: "approved", approvedBy: "user-1" });
      }),
    );

    renderWithProviders(
      <>
        <Toaster />
        <AgentesHerramientasPage />
      </>,
    );
    await screen.findByText("enviar_correo");
    await approveViaStepUp(user);

    await waitFor(() => expect(capturedStepUpHeader).toBe("step-up-1"));
    expect(capturedOrgIdHeader).toBe("org-a");
    expect(capturedBody).toEqual({ code: "123456", purpose: "tool_call.approval" });
    expect(await screen.findByText("tool_call aprobada.")).toBeInTheDocument();
  }, 15000);

  it("pide el step-up y envía X-Step-Up real al denegar", async () => {
    const user = userEvent.setup();
    let capturedBody: unknown;
    let capturedStepUpHeader: string | null = null;
    server.use(
      http.post("*/auth/2fa/step-up", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ stepUpToken: "step-up-2", expiresAt: "2026-01-01T00:10:00Z" });
      }),
      http.post("*/agents/tool-calls/:id/deny", ({ request }) => {
        capturedStepUpHeader = request.headers.get("x-step-up");
        return HttpResponse.json({ ...PENDING_TOOL_CALL, authorizationStatus: "denied", approvedBy: "user-1" });
      }),
    );

    renderWithProviders(
      <>
        <Toaster />
        <AgentesHerramientasPage />
      </>,
    );
    await screen.findByText("enviar_correo");
    await user.click(screen.getByRole("button", { name: "Denegar" }));
    await user.type(await screen.findByLabelText("Código TOTP o de respaldo", {}, { timeout: 10000 }), "123456");
    await user.click(screen.getByRole("button", { name: "Verificar y continuar" }));

    await waitFor(() => expect(capturedStepUpHeader).toBe("step-up-2"));
    expect(capturedBody).toEqual({ code: "123456", purpose: "tool_call.approval" });
    expect(await screen.findByText("tool_call denegada.")).toBeInTheDocument();
  }, 15000);

  it("sin 2FA enrolado, dirige a Configuración en vez de dejar que el 403 real llegue sin explicación", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: false, enrolledAt: null })));

    renderWithProviders(<AgentesHerramientasPage />);
    await screen.findByText("enviar_correo");

    await user.click(screen.getByRole("button", { name: "Aprobar" }));
    expect(await screen.findByText("Aún no tienes 2FA enrolado", {}, { timeout: 10000 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ir a Configuración/ })).toHaveAttribute("href", "/configuracion");
  }, 15000);

  it("un 403 real de apps/api (sin X-Step-Up vigente) se muestra como error honesto, no como éxito silencioso", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/agents/tool-calls/:id/approve", () =>
        HttpResponse.json(
          { type: "forbidden", title: "Esta acción exige verificación en dos pasos reciente", status: 403, requestId: "req-403" },
          { status: 403 },
        ),
      ),
    );

    renderWithProviders(
      <>
        <Toaster />
        <AgentesHerramientasPage />
      </>,
    );
    await screen.findByText("enviar_correo");
    await approveViaStepUp(user);

    expect(await screen.findByText(/verificación en dos pasos/i)).toBeInTheDocument();
  }, 15000);
});
