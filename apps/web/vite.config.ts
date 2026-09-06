import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// Ronda 3 (test:e2e:full): apps/api tiene un bug real de CORS descubierto
// por la suite E2E — su `@fastify/cors` (apps/api/src/app.ts) solo declara
// `access-control-allow-methods: GET,HEAD,POST` en el preflight, así que
// CUALQUIER escritura cross-origin con PUT/DELETE/PATCH (p. ej. `PUT
// /company/profile`, `DELETE /company/documents/:id`) la bloquea el propio
// navegador antes de que la petición llegue al servidor — reproducido con
// `curl -X OPTIONS` real (ver docs/logs/web-ronda3.log). Esto no es solo un
// problema de la suite E2E: afecta a CUALQUIER despliegue donde apps/web y
// apps/api vivan en orígenes distintos (típico en desarrollo local con
// puertos separados). Reportado como hallazgo de API pendiente (fuera de
// alcance de apps/web arreglarlo — ver README.md).
//
// Mitigación DENTRO de este ámbito, solo para `test:e2e:full`: quien
// arranca la API real (apps/web/scripts/e2e-full.mjs) expone su URL en
// `E2E_API_URL`; cuando esa variable existe, `vite preview`/`vite dev`
// proxean las rutas de la API al mismo origen que sirve el front (el
// patrón de despliegue real más común: un reverse proxy compartiendo
// origen) — así el navegador nunca ve una petición cross-origin y el bug
// de CORS de apps/api deja de bloquear la suite. `VITE_API_URL` se deja
// vacío en ese modo (ver e2e-full.mjs) para que el cliente
// (src/lib/api/http.ts) use rutas relativas.
const e2eApiTarget = process.env.E2E_API_URL;
const API_PROXY_PATHS = ["/auth", "/organizations", "/me", "/company", "/tenders", "/matching", "/agents", "/admin", "/healthz", "/readyz", "/docs"];
const apiProxy = e2eApiTarget
  ? Object.fromEntries(API_PROXY_PATHS.map((p) => [p, { target: e2eApiTarget, changeOrigin: true }]))
  : undefined;

// https://vitejs.dev/config/
export default defineConfig({
  base: "/",
  server: {
    host: "::",
    port: 8080,
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/@tanstack/")) return "query";
          if (id.includes("/@radix-ui/")) return "app-platform";
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    // La suite Playwright/axe vive en e2e/ (W-14) y usa su propio test
    // runner (`playwright test`, ver playwright.config.ts) — sin esta
    // exclusión, vitest intenta correr esos *.spec.ts con su runtime jsdom y
    // falla ("Playwright Test did not expect test.describe() to be called").
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/vite-env.d.ts", "src/**/*.d.ts"],
    },
  },
});
