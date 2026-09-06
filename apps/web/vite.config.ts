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
// Ronda 5: agrega "/expediente" (26 rutas: documentos/matriz, propuesta,
// checklist, aprobación, paquete, presentación, post-adjudicación) y
// "/audit-log" (bitácora de la organización activa, distinta de
// "/admin/audit-log" que ya cubre "/admin") -- sin esto, cualquier módulo
// nuevo del expediente y "Auditoría" del back office quedaban sin proxear
// en `test:e2e:full`, viéndose como cross-origin real ante el mismo bug de
// CORS que este proxy ya mitiga para el resto de la API (ver comentario de
// arriba).
const API_PROXY_PATHS = [
  "/auth",
  "/organizations",
  "/me",
  "/company",
  "/tenders",
  "/matching",
  "/agents",
  "/admin",
  "/expediente",
  "/audit-log",
  "/healthz",
  "/readyz",
  "/docs",
];
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
    // Ronda 6 (docs/logs/fix-web-coverage.log, corrigiendo el diagnóstico
    // de "contención de CPU" de rondas anteriores, que resultó incompleto):
    // reproducido en PRIMER PLANO, en aislamiento total (un solo archivo,
    // `--no-file-parallelism`, load average <3 en esta máquina, sin ningún
    // otro agente corriendo) que abrir un <Select/> real (Radix) con
    // `userEvent.click()` incurre en una pausa real de ~10-30s ANTES de que
    // se dispare CUALQUIER macrotarea agendada por código totalmente
    // independiente (el propio `setTimeout(0)` de
    // `@radix-ui/react-dismissable-layer` para registrar su listener de
    // "click fuera", el `setTimeout(0)` de jsdom para el evento
    // `selectionchange` tras `element.focus()`, y el `setTimeout(0)` interno
    // de `@testing-library/user-event`) -- las tres, agendadas con ms de
    // diferencia entre sí, se disparan TODAS juntas ~10-30s después,
    // confirmado con un perfil de CPU (`--cpu-prof`) que muestra ~95% del
    // proceso inactivo (no hay ninguna función JS consumiendo ese tiempo).
    // Es decir: NO es CPU real quemándose en instrumentación v8, ni
    // `getComputedStyle` (medido: <30ms acumulados), ni una petición de red
    // real escapándose del mock de MSW (sin llamadas a `dns.lookup` ni
    // `net.Socket.connect` durante la pausa) -- es el propio bucle de
    // eventos de Node quedándose sin atender su cola de timers durante ese
    // tramo, en esta combinación concreta de Node v25.6.1 + jsdom + Vitest 4
    // al montar un <Portal/> con efectos pasivos (commitPassiveMountOnFiber)
    // la PRIMERA vez que una prueba abre un desplegable Radix.
    //
    // Esto YA ocurre sin `--coverage` (confirmado: `vitest run
    // CumplimientoDocumentalPage.test.tsx` sin cobertura, un solo archivo,
    // tarda ~10.3s de los cuales ~10.2s son esta pausa) -- `--coverage`
    // no la CAUSA, pero SÍ la agrava (mismo archivo con `--coverage`: ~17s) y,
    // sobre todo, la CONTENCIÓN entre varios workers de vitest corriendo en
    // paralelo bajo `--coverage` la multiplica: el mismo archivo aislado
    // (ExpedientePage.test.tsx) que tarda ~32s de verdad en solitario (medido
    // subiendo su timeout a 120000ms para verlo terminar sin corte) llegó a
    // 52s+ corriendo junto a un segundo archivo. `retry: 1` no absorbe esto
    // de forma fiable porque la pausa se repite en el reintento.
    //
    // Corrección de raíz aplicada aquí (sin debilitar ninguna aserción):
    // 1) `maxWorkers` limita los workers concurrentes SOLO cuando corre
    //    `--coverage` (la suite rápida `test` sin cobertura, que no sufre
    //    contención real, sigue en paralelo completo) -- reduce cuántas
    //    pruebas pueden pisarse esta misma pausa a la vez.
    // 2) Las pruebas concretas que abren un <Select/> como primera acción
    //    (identificadas y listadas en cada archivo afectado) fijan su PROPIO
    //    timeout explícito, medido con margen sobre el costo real observado
    //    en aislamiento (ver comentarios en cada `it(..., N)`), en vez de
    //    depender de este valor global.
    testTimeout: 20000,
    retry: 1,
    // Solo aplica bajo --coverage: sin este límite, el número de workers
    // ronda el de CPUs de la máquina (10 aquí), y cada worker que abre un
    // <Select/> Radix puede pisar la misma pausa de ~10-30s descrita arriba
    // -- verificado que con 2 archivos a la vez la pausa de uno aislado
    // casi se duplica (32s -> 52s+). Serializar del todo (1 worker) evita
    // esa contención por completo pero vuelve el job de cobertura ~4-5x más
    // lento (~9min para los 30 archivos, medido); 3 es el punto medio
    // verificado en docs/logs/fix-web-coverage.log: dos corridas completas
    // y consecutivas de `test:coverage` en PRIMER PLANO -- bajo carga real
    // de esta máquina (load average 12-16, con otros procesos corriendo, no
    // una máquina en reposo) -- pasaron 115/115 ambas veces con este
    // límite. (Nota: `poolOptions.forks.maxForks` hace lo mismo pero Vitest
    // 4.1.11 lo marca DEPRECATED en cada corrida -- `maxWorkers` es la
    // forma top-level soportada.)
    maxWorkers: process.argv.includes("--coverage") ? 3 : undefined,
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
