import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import PrivacyNoticePage from "@/pages/PrivacyNoticePage";

describe("PrivacyNoticePage", () => {
  it("se marca explícitamente como borrador pendiente de validación jurídica", () => {
    render(
      <MemoryRouter>
        <PrivacyNoticePage />
      </MemoryRouter>,
    );
    expect(screen.getByText("Borrador pendiente de validación jurídica")).toBeInTheDocument();
  });

  it("cita la nueva LFPDPPP (DOF 20-marzo-2025) y a SABG como autoridad", () => {
    render(
      <MemoryRouter>
        <PrivacyNoticePage />
      </MemoryRouter>,
    );
    expect(screen.getAllByText(/20 de marzo de 2025/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SABG/).length).toBeGreaterThan(0);
  });
});
