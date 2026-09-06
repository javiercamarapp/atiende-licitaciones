import { coverageConfigDefaults, defineConfig } from "vitest/config";

/**
 * Umbral mínimo de cobertura exigido para packages/mail (ronda 6),
 * calibrado con el mismo criterio que el resto de los paquetes del
 * monorepo (packages/agents, packages/sources, packages/expediente):
 * `npm run test:coverage` falla si la cobertura real cae por debajo
 * de estos mínimos en vez de degradar silenciosamente.
 *
 * `exclude` PARTE de `coverageConfigDefaults.exclude` (no lo reemplaza):
 * pasar un `exclude` propio sin esto tira los patrones por defecto de
 * Vitest (que ya excluyen `**\/*.test.ts`, archivos de configuración,
 * etc.), y el reporte terminaría midiendo "cobertura" de las propias
 * pruebas — cada `*.test.ts` se ve a sí mismo al 100% y hasta el próximo
 * `eslint.config.js`/`vitest.config.ts` aparecería mostrando 0%.
 */
export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: [...coverageConfigDefaults.exclude, "scripts/**", "preview/**"],
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
      },
    },
  },
});
