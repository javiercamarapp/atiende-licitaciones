import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { CardTitle } from "@/components/ui/card";

describe("CardTitle", () => {
  it("por defecto renderiza un <h2> (evita saltar de h1 a h3, W-07)", () => {
    render(<CardTitle>Título de sección</CardTitle>);
    expect(screen.getByRole("heading", { level: 2, name: "Título de sección" })).toBeInTheDocument();
  });

  it("acepta un nivel explícito cuando el Card es el título de la página", () => {
    render(<CardTitle level={1}>Título de página</CardTitle>);
    expect(screen.getByRole("heading", { level: 1, name: "Título de página" })).toBeInTheDocument();
  });
});
