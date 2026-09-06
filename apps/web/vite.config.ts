import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from "./src/lib/security/csp";

// WI-01 (docs/auditoria-2/web-integrado.md): la auditoría reprodujo con
// `curl -sD -` que `vite preview` (el mismo artefacto que llegaría a
// producción) no servía NINGUNA cabecera de seguridad. Dos piezas, misma
// fuente de verdad (src/lib/security/csp.ts):
//
//  1. `transformIndexHtml`, activo SOLO cuando `command === "build"` (nunca
//     en `vite dev`): inyecta el meta tag CSP en el `index.html` que
//     termina en `dist/`. Se excluye de `vite dev` a propósito -- el
//     preámbulo de Fast Refresh de `@vitejs/plugin-react-swc` inyecta su
//     propio `<script type="module">` INLINE en el HTML de desarrollo, que
//     una CSP sin `'unsafe-inline'` en `script-src` bloquearía, rompiendo
//     HMR sin ganar nada real (nadie navega a `vite dev` en producción).
//     (Deliberadamente NO se usa el campo `apply: "build"` del propio
//     plugin: en Vite 6 eso también desactiva `configurePreviewServer` de
//     abajo durante `vite preview` -- verificado en vivo con `curl -sD -`,
//     las cabeceras nunca llegaban a la respuesta real. Guardar la condición
//     dentro del propio hook, con el `command` que ya resuelve
//     `defineConfig`, evita ese apagado accidental.)
//  2. `configurePreviewServer`, siempre activo (el hook en sí solo lo
//     invoca `vite preview`, ninguna otra fuente): cabeceras HTTP reales
//     para quien sirva `vite preview` directamente. El meta tag por sí
//     solo ya cubre `script-src`/`style-src`/etc., pero `frame-ancestors`
//     (ver SECURITY_HEADERS) SOLO funciona como cabecera HTTP real -- el
//     propio estándar CSP la ignora dentro de un `<meta>`.
function securityHeadersPlugin(command: "build" | "serve"): Plugin {
  return {
    name: "atiende-security-headers",
    transformIndexHtml(html) {
      if (command !== "build") return html;
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`,
      );
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
        next();
      });
    },
  };
}

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
export default defineConfig(({ command }) => ({
  base: "/",
  server: {
    host: "::",
    port: 8080,
    proxy: apiProxy,
  },
  preview: {
    proxy: apiProxy,
  },
  plugins: [react(), securityHeadersPlugin(command)],
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
}));
