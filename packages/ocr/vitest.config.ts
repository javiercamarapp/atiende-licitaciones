import { coverageConfigDefaults, defineConfig } from "vitest/config";

/**
 * Umbral de cobertura para `packages/ocr`, mismo criterio que el resto del
 * monorepo (`packages/mail`, `packages/sources`). El adaptador real
 * (`tesseract-adapter.ts`) se ejecuta de verdad en
 * `test/tesseract-adapter.test.ts` (motor OCR real contra una imagen
 * generada en la propia prueba, ver `test/support/render-text-image.ts`) --
 * no hay mocks del motor, solo del borde (imagen de entrada).
 */
export default defineConfig({
  test: {
    environment: "node",
    // El worker real de tesseract.js (WASM + trained data de ~3MB) tarda
    // más que una prueba unitaria típica -- se amplía el timeout SOLO para
    // esta suite, no se relaja ningún aserto.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: [...coverageConfigDefaults.exclude, "test/support/**"],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 80,
        statements: 80,
      },
    },
  },
});
