import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import DemoPage from "@/pages/DemoPage";

/**
 * jsdom (el entorno de esta suite unitaria) no implementa
 * `navigator.serviceWorker` -- exactamente el caso real que DemoPage.tsx
 * debe manejar de forma honesta (ver su docstring) en vez de fingir datos.
 * El camino feliz con el worker real arrancando de verdad y sirviendo datos
 * de ejemplo lo cubre la suite E2E (navegador real, ver e2e/demo.spec.ts).
 */
describe("DemoPage", () => {
  it("muestra un estado honesto cuando el navegador no soporta Service Workers", async () => {
    renderWithProviders(<DemoPage />);
    expect(await screen.findByText("Tu navegador no soporta esta demo")).toBeInTheDocument();
  });

  it("etiqueta claramente que se trata de datos de ejemplo", async () => {
    renderWithProviders(<DemoPage />);
    expect(await screen.findByText(/Datos de ejemplo/)).toBeInTheDocument();
  });

  it("enlaza de vuelta al inicio y a iniciar sesión", async () => {
    renderWithProviders(<DemoPage />);
    expect(await screen.findByRole("link", { name: /Volver al inicio/ })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /Iniciar sesión/ })).toHaveAttribute("href", "/login");
  });

  it("no tiene violaciones de accesibilidad detectables por axe", async () => {
    renderWithProviders(<DemoPage />);
    await screen.findByText("Tu navegador no soporta esta demo");
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  }, 15000);
});
