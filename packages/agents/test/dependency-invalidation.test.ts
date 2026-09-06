import { describe, expect, it } from "vitest";
import { DependencyInvalidationRegistry } from "../src/dependency-invalidation.js";

describe("DependencyInvalidationRegistry", () => {
  it("invalidate() marca como invalidados todos los runs que dependían de una versión anterior", () => {
    const registry = new DependencyInvalidationRegistry();
    registry.registerDependency("run-a", "convocatoria-1:bases", "v1");
    registry.registerDependency("run-b", "convocatoria-1:bases", "v1");
    registry.registerDependency("run-c", "convocatoria-1:bases", "v2"); // ya está en la versión nueva

    const invalidated = registry.invalidate("convocatoria-1:bases", "v2", "bases_republicadas");

    expect(invalidated.sort()).toEqual(["run-a", "run-b"]);
    expect(registry.isInvalidated("run-a")).toBe(true);
    expect(registry.isInvalidated("run-b")).toBe(true);
    expect(registry.isInvalidated("run-c")).toBe(false);
  });

  it("no afecta dependencias de otra clave distinta", () => {
    const registry = new DependencyInvalidationRegistry();
    registry.registerDependency("run-a", "convocatoria-1:bases", "v1");
    registry.registerDependency("run-b", "convocatoria-2:bases", "v1");

    registry.invalidate("convocatoria-1:bases", "v2", "cambio");

    expect(registry.isInvalidated("run-a")).toBe(true);
    expect(registry.isInvalidated("run-b")).toBe(false);
  });

  it("getInvalidation() expone versión anterior, nueva versión, razón y timestamp", () => {
    const registry = new DependencyInvalidationRegistry();
    registry.registerDependency("run-a", "convocatoria-1:plazo", "2026-09-10");
    registry.invalidate("convocatoria-1:plazo", "2026-09-05", "plazo_adelantado");

    const event = registry.getInvalidation("run-a");
    expect(event).toMatchObject({
      runId: "run-a",
      dependsOnKey: "convocatoria-1:plazo",
      previousVersion: "2026-09-10",
      newVersion: "2026-09-05",
      reason: "plazo_adelantado",
    });
    expect(typeof event?.timestamp).toBe("string");
  });

  it("clearInvalidation() permite volver a considerar un run como vigente tras regenerar", () => {
    const registry = new DependencyInvalidationRegistry();
    registry.registerDependency("run-a", "convocatoria-1:bases", "v1");
    registry.invalidate("convocatoria-1:bases", "v2", "cambio");
    expect(registry.isInvalidated("run-a")).toBe(true);

    registry.clearInvalidation("run-a");
    expect(registry.isInvalidated("run-a")).toBe(false);
  });

  it("una entidad sin dependientes registrados no lanza al invalidar", () => {
    const registry = new DependencyInvalidationRegistry();
    expect(() => registry.invalidate("clave-sin-dependientes", "v2", "cambio")).not.toThrow();
  });
});
