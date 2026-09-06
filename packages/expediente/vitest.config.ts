import { defineConfig } from "vitest/config";

/**
 * EX-EXP-21 (reverificación ronda 2, BAJA/CI): a diferencia de
 * `packages/agents` (AG-14), este paquete no tenía un gate de cobertura en
 * CI — `.github/workflows/quality.yml` hacía fallback silencioso a
 * `npm run test` (sin cobertura) para cualquier workspace sin script
 * `test:coverage`, así que una regresión futura de cobertura (p. ej.
 * reintroducir código muerto) no se detectaría. `npm run test:coverage`
 * ahora falla si la cobertura real cae por debajo de estos mínimos, con
 * `@vitest/coverage-v8` agregado como devDependency (mismo patrón que
 * `packages/agents/vitest.config.ts`). Valores calibrados con margen contra
 * la cobertura real medida en esta ronda — ver docs/logs/fix-expediente-ronda3.log.
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
