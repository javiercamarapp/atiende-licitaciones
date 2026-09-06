import { defineConfig, devices } from "@playwright/test";

// Suite E2E real (Playwright + axe-core sobre el navegador, no jsdom) exigida
// por REQ-049/REQ-065. Sirve el build de producción con `vite preview` — el
// mismo artefacto que llegaría a producción, no el servidor de desarrollo.
//
// W-23 (docs/auditoria-1/web-reverificacion-2.md): el puerto solía estar fijo
// en 4173 (el default de `vite preview`) con `reuseExistingServer:
// !process.env.CI`. En una máquina con varios agentes/worktrees corriendo
// `test:e2e` en paralelo, un segundo proceso ajeno ocupando ese mismo puerto
// por defecto hacía que Playwright diera por bueno lo que fuera que
// respondiera ahí (nunca llegaba a invocar `command`, así que ni siquiera
// `--strictPort` llegaba a fallar) — se reprodujo en vivo navegando a una
// ruta de OTRO proyecto. Dos mitigaciones independientes:
//   1. Puerto configurable vía `PLAYWRIGHT_PORT` (para quien quiera fijarlo
//      explícitamente, p. ej. en CI) con un default que YA NO es 4173 (el
//      puerto "obvio" que cualquier otro `vite preview` local también
//      probaría primero) sino uno derivado del PID del proceso de Playwright
//      — distinto en cada corrida concurrente sin coordinación manual.
//   2. `reuseExistingServer: false` siempre (no solo en CI): Playwright
//      arranca SIEMPRE su propio servidor con `--strictPort`; si el puerto
//      ya está ocupado, la corrida falla rápido y explícito (error de
//      arranque) en vez de reutilizar en silencio el servidor de otro
//      proceso. El costo (un arranque de `vite preview` por corrida en vez
//      de reutilizar uno ya tibio) es aceptable frente al riesgo de auditar
//      una build ajena sin darse cuenta.
// WI-05 (docs/auditoria-2/web-integrado.md): Playwright vuelve a IMPORTAR
// este archivo de configuración dentro de cada proceso worker (no solo en
// el proceso raíz que arranca `webServer`) -- así que calcular el puerto a
// partir de `process.pid` sin fijarlo en ninguna parte hacía que cada
// worker recalculara un puerto DISTINTO (su propio pid de proceso hijo,
// nunca el del proceso raíz que de verdad arrancó `vite preview`),
// resultando en `ERR_CONNECTION_REFUSED` real contra un puerto donde nunca
// corrió nada — reproducido en vivo corriendo esta suite con más de un
// worker sin `PLAYWRIGHT_PORT` explícito. Fijarlo en `process.env` la
// PRIMERA vez que se evalúa este módulo resuelve esto sin perder la
// randomización de W-23 (evitar chocar con otro `vite preview` local): los
// procesos worker que Playwright genera heredan el `env` del proceso raíz
// (comportamiento estándar de Node `child_process`), así que ya lo
// encuentran fijado y usan el MISMO valor en vez de recalcular el suyo.
if (!process.env.PLAYWRIGHT_PORT) {
  process.env.PLAYWRIGHT_PORT = String(4200 + (process.pid % 300));
}
const PORT = Number(process.env.PLAYWRIGHT_PORT);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

// Ronda 3: la UI ahora exige sesión real (W-12, RequireAuth) — casi ninguna
// pantalla es alcanzable sin login. Cuando `E2E_API_URL` está definida (ver
// apps/web/scripts/e2e-full.mjs / `npm run test:e2e:full`), `global-setup.ts`
// siembra dos usuarios/organizaciones reales llamando a la propia apps/api
// (deja las credenciales en `e2e/.artifacts/seed.json`); la autenticación de
// cada test la resuelve `e2e/fixtures.ts` (login fresco una vez por worker,
// contexto de navegador compartido — ver ese archivo para el porqué de NO
// usar un `storageState` estático compartido: el refresh token de apps/api
// rota con un solo uso, así que un archivo estático reutilizado por muchos
// contextos distintos falla para todos menos el primero en usarlo).
//
// `workers` se acota a 2 en modo "full": cada worker mintea su propio login
// de `admin` (uno por worker) + como mucho uno de `writer` (solo en el
// worker que corre e2e/ronda3-flujo-real.spec.ts, un `test.describe.serial`
// que Playwright nunca reparte entre workers) — con `POST /auth/login`
// limitado a 5/min por IP (apps/api/src/modules/auth/routes.ts), más de 2-3
// workers arriesgaría agotar ese límite en el arranque.
//
// Sin `E2E_API_URL` (`npm run test:e2e` a secas, sin backend), no hay seed
// que leer: la suite queda limitada a lo que sea alcanzable sin sesión
// (fundamentalmente `/login`, vía el fixture `noAuthPage`) — ver README.md.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Modo "full": 94+ pruebas reales en un solo proceso de Chromium continuo
  // (varios minutos) ocasionalmente cierran una página/contexto de forma
  // transitoria ("Target page, context or browser has been closed") por
  // presión de recursos acumulada, no por una regresión real — un reintento
  // absorbe eso sin ocultar un fallo genuino (que vuelve a fallar igual la
  // segunda vez).
  retries: process.env.CI ? 1 : process.env.E2E_API_URL ? 1 : 0,
  workers: process.env.E2E_API_URL ? 1 : undefined,
  // Modo "full": cada navegación real dispara 3-4 peticiones de arranque de
  // sesión (refresh + /me + /organizations) contra una apps/api real con
  // límite de tasa (100/min global); bajo ráfagas sostenidas (p. ej. recorrer
  // 24 rutas seguidas) el cliente reintenta 429 con backoff (ver
  // src/lib/api/http.ts) — el timeout por test por defecto (30s) no siempre
  // deja margen para esos reintentos. 45s da ese margen sin disimular una
  // regresión real (una prueba que de verdad cuelga sigue fallando igual).
  timeout: process.env.E2E_API_URL ? 45_000 : undefined,
  reporter: [["list"]],
  globalSetup: process.env.E2E_API_URL ? "./e2e/global-setup.ts" : undefined,
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run preview -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
