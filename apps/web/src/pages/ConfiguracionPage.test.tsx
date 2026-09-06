import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import { Toaster } from "@/components/ui/sonner";
import ConfiguracionPage from "@/pages/ConfiguracionPage";

function mockAuthenticatedSession() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
    http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
  );
}

describe("ConfiguracionPage", () => {
  beforeEach(() => {
    mockAuthenticatedSession();
  });

  it("muestra el estado real de 2FA cuando ya está enrolado", async () => {
    server.use(http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: true, enrolledAt: "2026-01-01T00:00:00Z" })));
    renderWithProviders(<ConfiguracionPage />);
    expect(await screen.findByText("Enrolado")).toBeInTheDocument();
  }, 15000);

  it("enrola 2FA: muestra el secreto y los códigos de respaldo, y confirma con un código", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/auth/2fa/status", () => HttpResponse.json({ enrolled: false, enrolledAt: null })),
      http.post("*/auth/2fa/enroll", () =>
        HttpResponse.json(
          { secretBase32: "ABCD1234EFGH5678", otpauthUrl: "otpauth://totp/x", backupCodes: ["AAAA-1111", "BBBB-2222"] },
          { status: 201 },
        ),
      ),
      http.post("*/auth/2fa/verify-enrollment", () =>
        HttpResponse.json({ enrolled: true, stepUpToken: "step-1", expiresAt: "2026-01-01T00:10:00Z" }),
      ),
    );

    renderWithProviders(
      <>
        <Toaster />
        <ConfiguracionPage />
      </>,
    );
    await user.click(await screen.findByRole("button", { name: "Enrolar 2FA" }));

    expect(await screen.findByText("ABCD1234EFGH5678")).toBeInTheDocument();
    expect(screen.getByText("AAAA-1111")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Código de 6 dígitos"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirmar enrolamiento" }));

    expect(await screen.findByText(/2FA enrolado y verificado/)).toBeInTheDocument();
  }, 15000);
});
