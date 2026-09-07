import { defineConfig } from "vitest/config";

/**
 * Umbral mínimo de cobertura, mismo criterio que `packages/agents` y
 * `packages/mail`: `npm run test:coverage` falla si la cobertura real cae
 * por debajo de estos mínimos en vez de degradar en silencio.
 */
export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
      },
    },
  },
});
