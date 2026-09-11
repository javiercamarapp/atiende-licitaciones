import { defineConfig } from "vitest/config";

/**
 * Umbral mínimo de cobertura, mismo criterio y mismos valores que
 * `packages/mail`/`packages/whatsapp`/`packages/expediente`:
 * `npm run test:coverage` falla si la cobertura real cae por debajo de
 * estos mínimos en vez de degradar en silencio. Calibrado con margen
 * contra la cobertura real medida en esta ronda (94.9% líneas / 92.8%
 * ramas / 87.5% funciones / 94.9% sentencias) — el 87.5% de funciones es
 * `index.ts` (solo re-exportaciones, sin lógica propia que probar)
 * diluyendo el promedio de un paquete pequeño; NO se excluye del reporte
 * porque también sirve como red si algún día deja de ser un barrel puro.
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
