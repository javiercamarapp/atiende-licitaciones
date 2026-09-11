import { defineConfig } from "vitest/config";

/**
 * Mismo patrón que `packages/agents/vitest.config.ts` / `packages/
 * expediente/vitest.config.ts`: `test:coverage` falla si la cobertura real
 * cae por debajo de estos mínimos. Valores calibrados con margen contra la
 * cobertura REAL medida en esta ronda (ver comando/salida en
 * docs/ACEPTACION.md REQ-087).
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      thresholds: {
        lines: 90,
        branches: 80,
        functions: 90,
        statements: 90,
      },
    },
  },
});
