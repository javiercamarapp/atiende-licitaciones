import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import LoginPage from "@/pages/LoginPage";

// Radix Tabs mantiene montados ambos paneles (el inactivo queda con el
// atributo `hidden`), así que "Correo electrónico" existe dos veces en el
// DOM al mismo tiempo. Se acota la búsqueda al tabpanel visible —
// `getByRole` excluye por defecto los nodos con `hidden`.
function panelActivo() {
  return within(screen.getByRole("tabpanel"));
}

describe("LoginPage", () => {
  it("tiene un landmark <main> y un <h1> real (W-08)", () => {
    renderWithProviders(<LoginPage />);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Accede a tu panel de licitaciones" })).toBeInTheDocument();
  });

  it("valida el formulario de contraseña con zod antes de enviar", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    expect(await screen.findByText("Ingresa tu correo electrónico.")).toBeInTheDocument();
    expect(screen.getByText("La contraseña debe tener al menos 8 caracteres.")).toBeInTheDocument();
  });

  it("rechaza un correo con formato inválido", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);
    const panel = panelActivo();

    await user.type(panel.getByLabelText("Correo electrónico"), "no-es-un-correo");
    await user.type(panel.getByLabelText("Contraseña"), "12345678");
    await user.click(screen.getByRole("button", { name: "Iniciar sesión" }));

    expect(await screen.findByText("Ingresa un correo electrónico válido.")).toBeInTheDocument();
  });

  it("valida el formulario de enlace mágico con zod", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.click(screen.getByRole("tab", { name: /Enlace mágico/ }));
    await user.click(screen.getByRole("button", { name: "Enviar enlace de acceso" }));

    expect(await screen.findByText("Ingresa tu correo electrónico.")).toBeInTheDocument();
  });

  it("no tiene violaciones de accesibilidad detectables por axe", async () => {
    const { container } = renderWithProviders(<LoginPage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  }, 15000);
});
