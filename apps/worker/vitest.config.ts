import { defineConfig } from 'vitest/config';

/**
 * WK-11 (docs/auditoria-1/worker.md): antes de esta ronda no había
 * `@vitest/coverage-v8` instalado ni script `test:coverage` — `npx vitest
 * run --coverage` fallaba con `MISSING DEPENDENCY` y no era posible
 * cuantificar cobertura de líneas/branches más allá del conteo de tests.
 * Mismo patrón que `packages/agents/vitest.config.ts` (AG-14): umbrales
 * mínimos que hacen fallar `test:coverage` si la cobertura real cae por
 * debajo, en vez de degradar silenciosamente sin que nadie lo note.
 * Umbrales calibrados igual que el resto del monorepo (líneas ≥85%,
 * ramas ≥80%) — ver docs/logs/fix-worker-ronda2.log para la cobertura real
 * medida en esta ronda.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      /**
       * `src/index.ts` es el entrypoint/composition-root real del proceso
       * (arranca DB real, señales de proceso SIGTERM/SIGINT,
       * `process.exit`): ejercitarlo de verdad requeriría un proceso hijo
       * real (spawn), no una prueba unitaria — toda su lógica de negocio
       * (JobQueue/Worker/Scheduler/handlers) ya está cubierta por separado
       * en sus propios módulos. Excluirlo de cobertura es la misma
       * convención que ya usa el resto del monorepo para entrypoints
       * (ver p. ej. cómo apps/api trata su propio `src/index.ts`), no una
       * forma de esconder código sin probar.
       */
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 85,
        branches: 80,
      },
    },
  },
});
