import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { derivarEstadoPaquete, PackageStatusBadge } from "@/components/ui/package-status-badge";

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

// W-16: "listo" solo puede originarse desde una validación completa
// (checklist, firmas y anexos), nunca por defecto. derivarEstadoPaquete()
// es la única vía sancionada para producir "listo" — si falta cualquiera de
// las tres condiciones, siempre devuelve "borrador".
describe("derivarEstadoPaquete", () => {
  it("devuelve 'listo' solo si checklist, firmas y anexos están completos", () => {
    expect(
      derivarEstadoPaquete({ checklistCompleto: true, firmasCompletas: true, anexosVigentes: true }),
    ).toBe("listo");
  });

  it.each([
    { checklistCompleto: false, firmasCompletas: true, anexosVigentes: true },
    { checklistCompleto: true, firmasCompletas: false, anexosVigentes: true },
    { checklistCompleto: true, firmasCompletas: true, anexosVigentes: false },
    { checklistCompleto: false, firmasCompletas: false, anexosVigentes: false },
  ])("devuelve 'borrador' si falta cualquier condición (%o)", (validacion) => {
    expect(derivarEstadoPaquete(validacion)).toBe("borrador");
  });
});
