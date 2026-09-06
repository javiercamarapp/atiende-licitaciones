import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import PrivacyNoticePage from "@/pages/PrivacyNoticePage";

const NOTICE = {
  version: 1,
  publishedAt: "2026-09-06",
  status: "borrador_pendiente_validacion_juridica" as const,
  responsible: "Atiende Licitaciones",
  supervisoryAuthority: "Secretaría Anticorrupción y Buen Gobierno (SABG)",
  applicableLaw: "LFPDPPP nueva, DOF 20-marzo-2025",
  sourceDocument: "docs/legal/verificacion-legal.md",
  contentMarkdown: "# Aviso de privacidad\n\n## 1. Responsable\n\nAtiende Licitaciones trata datos personales. Vigente desde el 20 de marzo de 2025.\n",
};

describe("PrivacyNoticePage", () => {
  beforeEach(() => {
    server.use(http.get("*/legal/privacy-notice", () => HttpResponse.json(NOTICE)));
  });

  it("se marca explícitamente como borrador pendiente de validación jurídica (servido por GET /legal/privacy-notice)", async () => {
    renderWithProviders(<PrivacyNoticePage />);
    expect(await screen.findByText("Borrador pendiente de validación jurídica")).toBeInTheDocument();
  });

  it("cita la nueva LFPDPPP (DOF 20-marzo-2025) y a SABG como autoridad", async () => {
    renderWithProviders(<PrivacyNoticePage />);
    await screen.findByText("Borrador pendiente de validación jurídica");
    expect(screen.getAllByText(/20 de marzo de 2025|20-marzo-2025/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SABG/).length).toBeGreaterThan(0);
  });
});
