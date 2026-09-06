import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import type { SeedData } from "./global-setup";

// ESM real ("type": "module" en package.json): sin `__dirname` global.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(__dirname, ".artifacts", "seed.json");

function readSeed(): SeedData | null {
  if (!process.env.E2E_API_URL) return null;
  try {
    return JSON.parse(fs.readFileSync(SEED_PATH, "utf8")) as SeedData;
  } catch {
    return null;
  }
}

/**
 * Inicia sesión llamando DIRECTAMENTE a apps/api (sin pasar por el
 * navegador) y devuelve el refresh token real. `POST /auth/login` es
 * repetible sin límite estructural (a diferencia de `POST /auth/refresh`,
 * que rota y revoca el token usado) — por eso es seguro llamarlo una vez
 * por worker/identidad sin arriesgar una colisión de "token ya usado" entre
 * varios contextos de navegador concurrentes.
 */
/**
 * `POST /auth/login` tiene un límite de 5/min POR IP en apps/api (no por
 * usuario, ver `config: { rateLimit: { max: 5, timeWindow: '1 minute' } }`
 * en apps/api/src/modules/auth/routes.ts) — con varios workers minteando su
 * propio login casi al mismo tiempo desde 127.0.0.1, un 429 ocasional aquí
 * es un comportamiento REAL de la API, no un bug de la suite. Se reintenta
 * con backoff en vez de fallar toda la corrida por una colisión de
 * temporización.
 */
async function loginAndGetRefreshToken(apiUrl: string, email: string, password: string): Promise<string> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(`${apiUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (response.ok) {
      const body = (await response.json()) as { refreshToken: string };
      return body.refreshToken;
    }
    if (response.status === 429 && attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      continue;
    }
    throw new Error(`Login de seed falló (${response.status}) para ${email}: ${await response.text()}`);
  }
  throw new Error(`Login de seed agotó los reintentos (rate limit) para ${email}`);
}

/**
 * App.tsx carga cada página con React.lazy()/Suspense: el evento "load" del
 * navegador (el que espera `page.goto()` por defecto) dispara en cuanto se
 * ejecuta el bundle de entrada, no cuando termina de llegar el chunk de la
 * ruta — mientras tanto el DOM real es la `LoadingScreen` (un `role="status"`
 * sin landmarks ni encabezados). Sin esperar a que la red esté quieta, una
 * aserción de axe o de foco que corre justo después de `goto()` puede
 * terminar auditando la pantalla de carga en vez de la página real, dando
 * "violaciones" o fallos de foco que no existen (falsos positivos
 * intermitentes, más frecuentes cuantos más workers compiten por CPU/red).
 */
function wrapGotoWaitsForNetworkIdle(page: Page): void {
  const originalGoto = page.goto.bind(page);
  page.goto = (async (url: string, options?: Parameters<Page["goto"]>[1]) => {
    const response = await originalGoto(url, options);
    await page.waitForLoadState("networkidle");
    return response;
  }) as Page["goto"];
}

interface Fixtures {
  page: Page;
  /** Página autenticada como el usuario `writer` del seed (solo miembro de
   * la organización A) — usada por e2e/ronda3-flujo-real.spec.ts para
   * demostrar el flujo de proponer tarifas y el 403 honesto de back office. */
  writerPage: Page;
  /** Página SIN ninguna sesión — para las pruebas que necesitan ver el
   * formulario real de /login en vez de la redirección a /panel. */
  noAuthPage: Page;
}

interface WorkerFixtures {
  /**
   * Contexto de navegador COMPARTIDO por todos los tests de este worker que
   * usan la identidad `admin` del seed (el fixture `page` por defecto). Es
   * intencional que sea `scope: "worker"` (no uno nuevo por test): el
   * refresh token del seed se mintea una sola vez por worker vía
   * `POST /auth/login` real y se inyecta en `localStorage` con
   * `addInitScript`; como el contexto (y por tanto su `localStorage`) se
   * comparte entre todos los `page` de ese worker, la rotación real de
   * tokens (`POST /auth/refresh`, un solo uso — ver
   * apps/api/src/modules/auth/routes.ts) queda siempre al día en un único
   * lugar en vez de perderse cada vez que un test nuevo leyera un
   * `storageState` estático ya rotado por otro test/worker (el bug real que
   * tuvo la primera versión de este archivo: la mayoría de las 24 rutas
   * fallaban porque cada test nuevo intentaba refrescar con un refresh
   * token que otro test ya había consumido).
   */
  adminContext: BrowserContext;
  writerContext: BrowserContext;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  adminContext: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      const seed = readSeed();
      if (seed) {
        const refreshToken = await loginAndGetRefreshToken(seed.apiUrl, seed.admin.email, seed.admin.password);
        // `addInitScript` corre en CADA documento nuevo de este contexto
        // (cada `newPage()`/navegación dura), no solo en el primero. Sin el
        // `if`, reescribiría el refresh token original (ya usado y rotado
        // por la primera página) en TODAS las páginas siguientes,
        // deshaciendo la rotación real y forzando un 401 en
        // `POST /auth/refresh` en cuanto la segunda página intentara
        // reutilizar ese token ya consumido — exactamente la causa real por
        // la que la mayoría de las rutas fallaban en una versión anterior de
        // este archivo. Solo se siembra si `localStorage` todavía no tiene
        // ningún valor (primera carga de este contexto); de ahí en adelante
        // el propio cliente (`src/lib/api/session.ts`) mantiene el valor
        // vivo y rotado en cada refresh.
        await context.addInitScript((token: string) => {
          if (!window.localStorage.getItem("atiende.refreshToken")) {
            window.localStorage.setItem("atiende.refreshToken", token);
          }
        }, refreshToken);
      }
      await use(context);
      await context.close();
    },
    { scope: "worker" },
  ],

  writerContext: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      const seed = readSeed();
      if (seed) {
        const refreshToken = await loginAndGetRefreshToken(seed.apiUrl, seed.writer.email, seed.writer.password);
        // `addInitScript` corre en CADA documento nuevo de este contexto
        // (cada `newPage()`/navegación dura), no solo en el primero. Sin el
        // `if`, reescribiría el refresh token original (ya usado y rotado
        // por la primera página) en TODAS las páginas siguientes,
        // deshaciendo la rotación real y forzando un 401 en
        // `POST /auth/refresh` en cuanto la segunda página intentara
        // reutilizar ese token ya consumido — exactamente la causa real por
        // la que la mayoría de las rutas fallaban en una versión anterior de
        // este archivo. Solo se siembra si `localStorage` todavía no tiene
        // ningún valor (primera carga de este contexto); de ahí en adelante
        // el propio cliente (`src/lib/api/session.ts`) mantiene el valor
        // vivo y rotado en cada refresh.
        await context.addInitScript((token: string) => {
          if (!window.localStorage.getItem("atiende.refreshToken")) {
            window.localStorage.setItem("atiende.refreshToken", token);
          }
        }, refreshToken);
      }
      await use(context);
      await context.close();
    },
    { scope: "worker" },
  ],

  page: async ({ adminContext }, use) => {
    const page = await adminContext.newPage();
    wrapGotoWaitsForNetworkIdle(page);
    await use(page);
    await page.close();
  },

  writerPage: async ({ writerContext }, use) => {
    const page = await writerContext.newPage();
    wrapGotoWaitsForNetworkIdle(page);
    await use(page);
    await page.close();
  },

  noAuthPage: async ({ browser }, use) => {
    // Contexto nuevo y aislado por test (no worker-scoped): estas pruebas
    // solo escriben en el formulario de /login, nunca llaman a
    // POST /auth/login de verdad, así que no hay ningún token que
    // compartir ni riesgo de agotar el rate limit de esa ruta (5/min).
    const context = await browser.newContext();
    const page = await context.newPage();
    wrapGotoWaitsForNetworkIdle(page);
    await use(page);
    await context.close();
  },
});

export { expect };
