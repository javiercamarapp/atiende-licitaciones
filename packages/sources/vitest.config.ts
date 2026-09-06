import { defineConfig } from "vitest/config";

/**
 * SR-08: antes de este archivo no había `vitest.config.ts` ni script con
 * `--coverage`; la "cobertura real" del paquete se basaba solo en conteo de
 * tests + mutación manual (ver docs/auditoria-1/sources.md §8), sin un
 * reporte de cobertura de líneas/ramas verificable. `npm run test:coverage`
 * ahora falla el build si la cobertura real cae por debajo de los umbrales.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "text-summary"],
      thresholds: {
        lines: 85,
        branches: 80,
      },
    },
  },
});
