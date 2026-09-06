import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ThemeSelector } from "@/components/ThemeSelector";

describe("ThemeSelector", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("es un radiogroup accesible con las tres opciones", () => {
    render(<ThemeSelector />);
    expect(screen.getByRole("radiogroup", { name: "Tema de la interfaz" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Tema claro" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Seguir al sistema" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Tema oscuro" })).toBeInTheDocument();
  });

  it("agrega la clase .dark al elegir tema oscuro y la quita al elegir claro", async () => {
    const user = userEvent.setup();
    render(<ThemeSelector />);

    await user.click(screen.getByRole("radio", { name: "Tema oscuro" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByRole("radio", { name: "Tema oscuro" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "Tema claro" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
