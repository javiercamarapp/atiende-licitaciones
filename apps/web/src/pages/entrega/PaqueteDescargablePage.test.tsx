import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import PaqueteDescargablePage from "@/pages/entrega/PaqueteDescargablePage";

describe("PaqueteDescargablePage", () => {
  it("muestra el estado 'Borrador' por defecto y nunca 'Listo para presentar'", () => {
    render(<PaqueteDescargablePage />);
    expect(screen.getByText("Borrador")).toBeInTheDocument();
    expect(screen.queryByText("Listo para presentar")).not.toBeInTheDocument();
  });

  it("muestra el aviso permanente de que la presentación y firma las realiza el usuario", () => {
    render(<PaqueteDescargablePage />);
    expect(screen.getByText("La presentación y firma las realiza el usuario")).toBeInTheDocument();
  });

  it("no simula un paquete ya generado: expone el estado vacío honesto", () => {
    render(<PaqueteDescargablePage />);
    expect(screen.getByText("Aún no hay paquete generado")).toBeInTheDocument();
  });
});
