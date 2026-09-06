import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import { AppShell } from "@/components/layout/AppShell";
import { ALL_NAV_ITEMS } from "@/config/navigation";

function renderShell(route = "/panel") {
  return renderWithProviders(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/panel" element={<div>Contenido del panel</div>} />
      </Route>
    </Routes>,
    { route },
  );
}

describe("AppShell / sidebar", () => {
  it("muestra todos los items de navegación con su enlace correcto", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Navegación principal" });

    for (const item of ALL_NAV_ITEMS) {
      const link = within(nav).getByRole("link", { name: item.label });
      expect(link).toHaveAttribute("href", item.to);
    }
  });

  it("incluye los items de la ampliación de back office (Empresa, Fuentes y frescura, Expediente, Aprobaciones, Paquete descargable)", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Navegación principal" });

    const nuevosItems: Array<{ label: string; to: string }> = [
      { label: "Perfil y capacidades", to: "/empresa/perfil-capacidades" },
      { label: "Documentos y vigencias", to: "/empresa/documentos-vigencias" },
      { label: "Firmantes autorizados", to: "/empresa/firmantes-autorizados" },
      { label: "Tarifas aprobadas", to: "/empresa/tarifas-aprobadas" },
      { label: "Fuentes y frescura", to: "/convocatorias/fuentes-frescura" },
      { label: "Expediente", to: "/preparacion/expediente" },
      { label: "Aprobaciones", to: "/preparacion/aprobaciones" },
      { label: "Paquete descargable", to: "/entrega/paquete-descargable" },
    ];

    for (const item of nuevosItems) {
      expect(within(nav).getByRole("link", { name: item.label })).toHaveAttribute("href", item.to);
    }
  });

  it("tiene landmarks de header, navegación y contenido principal", () => {
    renderShell();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Navegación principal" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByText("Contenido del panel")).toBeInTheDocument();
  });

  it("incluye un skip-link al contenido principal", () => {
    renderShell();
    const skipLink = screen.getByRole("link", { name: "Saltar al contenido principal" });
    expect(skipLink).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("abre y cierra el drawer móvil de forma accesible", async () => {
    const user = userEvent.setup();
    renderShell();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const openButton = screen.getByRole("button", { name: "Abrir menú de navegación" });
    await user.click(openButton);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole("navigation", { name: "Navegación principal" })).toBeInTheDocument();

    const closeButton = within(dialog).getByRole("button", { name: "Cerrar menú" });
    await user.click(closeButton);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("no tiene violaciones de accesibilidad detectables por axe", async () => {
    const { container } = renderShell();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  }, 15000);
});
