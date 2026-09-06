import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";

describe("EmptyState", () => {
  it("muestra título y descripción, y ejecuta la acción al hacer click", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(
      <EmptyState
        title="Aún no hay convocatorias descubiertas"
        description="Configura una fuente para empezar."
        actionLabel="Configurar fuente"
        onAction={onAction}
      />,
    );

    expect(screen.getByText("Aún no hay convocatorias descubiertas")).toBeInTheDocument();
    expect(screen.getByText("Configura una fuente para empezar.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Configurar fuente" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("no renderiza un botón de acción si no se pasa onAction", () => {
    render(<EmptyState title="Sin datos" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("muestra el mensaje real del error y permite reintentar", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<ErrorState message="No se pudo conectar con el servidor: timeout tras 10s." onRetry={onRetry} />);

    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo conectar con el servidor: timeout tras 10s.");
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("LoadingState", () => {
  it("expone un status accesible para lectores de pantalla", () => {
    render(<LoadingState label="Cargando convocatorias…" />);
    expect(screen.getByRole("status", { name: "Cargando convocatorias…" })).toBeInTheDocument();
  });
});
