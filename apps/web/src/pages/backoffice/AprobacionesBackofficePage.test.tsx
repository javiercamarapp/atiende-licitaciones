import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import { Toaster } from "@/components/ui/sonner";
import AprobacionesBackofficePage from "@/pages/backoffice/AprobacionesBackofficePage";

const PENDING = { id: "tc-1", orgId: "org-b", orgName: "Organización B", toolName: "enviar_correo", agentRunId: "run-1", createdAt: "2026-01-05T00:00:00Z" };

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "superadmin@empresa.com", fullName: "Superadmin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    http.get("*/admin/approvals", () => HttpResponse.json([PENDING])),
  );
}

describe("AprobacionesBackofficePage", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("aprueba una tool_call cross-org real sin necesidad de cambiar de organización", async () => {
    const user = userEvent.setup();
    let approveCalled = false;
    server.use(
      http.post("*/admin/tool-calls/:id/approve", () => {
        approveCalled = true;
        return HttpResponse.json({ id: PENDING.id, agentRunId: "run-1", toolName: "enviar_correo", authorizationStatus: "approved", status: null, approvedBy: "user-1", approvedAt: "2026-01-06T00:00:00Z", createdAt: PENDING.createdAt });
      }),
    );

    renderWithProviders(
      <>
        <Toaster />
        <AprobacionesBackofficePage />
      </>,
    );
    await screen.findByText("Organización B");
    await user.click(screen.getByRole("button", { name: "Aprobar" }));

    await waitFor(() => expect(approveCalled).toBe(true));
  }, 15000);
});
