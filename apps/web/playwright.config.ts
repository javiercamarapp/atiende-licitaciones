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
const PORT = Number(process.env.PLAYWRIGHT_PORT) || 4200 + (process.pid % 300);
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
  retries: process.env.CI ? 1 : 0,
  workers: process.env.E2E_API_URL ? 1 : undefined,
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
