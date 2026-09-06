import { defineConfig } from "vitest/config";

/**
 * AG-14: umbral mínimo de cobertura exigido, con `@vitest/coverage-v8`
 * (agregado como devDependency). `npm run test:coverage` falla si la
 * cobertura real cae por debajo de estos mínimos, en vez de degradar
 * silenciosamente sin que nadie lo note. Valores calibrados contra la
 * cobertura real medida en esta ronda (Statements 94.44% / Branches 91.28%
 * / Functions 93.54% / Lines 94.44%, ver docs/logs/fix-agents-ronda1.log),
 * con margen para no ser frágiles ante cambios menores futuros.
 */
export default defineConfig({
  test: {
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
