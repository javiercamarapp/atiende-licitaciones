import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import FuentesFrescuraPage from "@/pages/convocatorias/FuentesFrescuraPage";

describe("FuentesFrescuraPage", () => {
  it("muestra la leyenda de los cinco estados posibles de una fuente", () => {
    render(<FuentesFrescuraPage />);
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.getByText("Caída")).toBeInTheDocument();
    expect(screen.getByText("CAPTCHA")).toBeInTheDocument();
    expect(screen.getByText("Cambio de interfaz")).toBeInTheDocument();
    expect(screen.getByText("Permisos faltantes")).toBeInTheDocument();
  });

  it("no muestra fuentes inventadas: expone el estado vacío honesto", () => {
    render(<FuentesFrescuraPage />);
    expect(screen.getByText("Aún no hay fuentes configuradas")).toBeInTheDocument();
  });
});
