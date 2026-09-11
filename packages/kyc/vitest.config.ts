import { coverageConfigDefaults, defineConfig } from "vitest/config";

/**
 * Umbral mínimo de cobertura para packages/kyc, mismo criterio que el
 * resto del monorepo (packages/mail, packages/sources, packages/expediente):
 * `npm run test:coverage` falla si la cobertura real cae por debajo de
 * estos mínimos.
 */
export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: [...coverageConfigDefaults.exclude, "test/fixtures/**"],
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
      },
    },
  },
});
