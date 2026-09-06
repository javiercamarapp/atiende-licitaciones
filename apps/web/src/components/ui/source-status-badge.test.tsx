import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { SourceStatusBadge, type FuenteEstado } from "@/components/ui/source-status-badge";

const CASOS: Array<{ estado: FuenteEstado; label: string }> = [
  { estado: "ok", label: "OK" },
  { estado: "caida", label: "Caída" },
  { estado: "captcha", label: "CAPTCHA" },
  { estado: "cambio_interfaz", label: "Cambio de interfaz" },
  { estado: "permisos_faltantes", label: "Permisos faltantes" },
];

describe("SourceStatusBadge", () => {
  it.each(CASOS)("muestra una etiqueta explícita para el estado '$estado'", ({ estado, label }) => {
    render(<SourceStatusBadge estado={estado} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("nunca muestra el mismo texto para estados distintos (una fuente caída no se confunde con ok)", () => {
    const etiquetas = CASOS.map((c) => c.label);
    expect(new Set(etiquetas).size).toBe(CASOS.length);
  });
});
