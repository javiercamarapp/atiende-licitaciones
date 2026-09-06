import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { PackageStatusBadge } from "@/components/ui/package-status-badge";

describe("PackageStatusBadge", () => {
  it("muestra 'Borrador' para el estado borrador", () => {
    render(<PackageStatusBadge estado="borrador" />);
    expect(screen.getByText("Borrador")).toBeInTheDocument();
  });

  it("muestra 'Listo para presentar' solo cuando el estado es explícitamente 'listo'", () => {
    render(<PackageStatusBadge estado="listo" />);
    expect(screen.getByText("Listo para presentar")).toBeInTheDocument();
  });
});
