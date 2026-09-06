import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import TermsPage from "@/pages/TermsPage";

describe("TermsPage", () => {
  it("muestra el título, el aviso de borrador pendiente y marcadores FaltaDato", async () => {
    renderWithProviders(<TermsPage />);

    expect(await screen.findByRole("heading", { level: 1, name: "Términos de servicio" })).toBeInTheDocument();
    expect(screen.getByText("Borrador pendiente de validación jurídica")).toBeInTheDocument();
    expect(screen.getAllByText(/FaltaDato/).length).toBeGreaterThan(0);
  });

  it("explica las reglas de no actuación de la plataforma", async () => {
    renderWithProviders(<TermsPage />);
    expect(await screen.findByText(/No presenta ni envía tu propuesta/)).toBeInTheDocument();
  });

  it("enlaza de vuelta al inicio", async () => {
    renderWithProviders(<TermsPage />);
    expect(await screen.findByRole("link", { name: /Volver al inicio/ })).toHaveAttribute("href", "/");
  });

  it("no tiene violaciones de accesibilidad detectables por axe", async () => {
    renderWithProviders(<TermsPage />);
    await screen.findByRole("main");
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  }, 15000);
});
