#!/usr/bin/env node
// Orquesta `test:e2e:full`: arranca apps/api de verdad (PGlite en memoria,
// sin datos ficticios en el frontend — el seed mínimo se crea llamando a la
// propia API), espera a que esté lista, construye apps/web apuntando a esa
// API real y corre la suite Playwright completa contra ella. Al terminar
// (éxito o fallo) apaga la API y propaga el código de salida real de
// Playwright — nunca se informa éxito si la suite falló.
//
// Uso: `npm run -w apps/web test:e2e:full` (ver apps/web/package.json).
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBrowserFakeOidcProvider } from "./fake-oidc-server.mjs";

const WEB_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..", "..");
const API_ROOT = path.join(REPO_ROOT, "apps", "api");

const API_PORT = Number(process.env.E2E_API_PORT) || 3400 + Math.floor(Math.random() * 300);
const WEB_PORT = Number(process.env.PLAYWRIGHT_PORT) || 4200 + Math.floor(Math.random() * 300);
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
// Ronda 5: e2e/global-setup.ts usa esta clave (vía X-Platform-Api-Key) para
// sembrar UNA convocatoria real por POST /internal/tenders/ingest antes de
// e2e/expediente-flujo-completo.spec.ts -- la única ruta que puede crear
// `tenders` (ver apps/api/README.md). Literal fijo de esta suite, nunca
// usado fuera de test:e2e:full.
const PLATFORM_API_KEY = "e2e-seed-platform-key-not-production";

function log(msg) {
  console.log(`[test:e2e:full] ${msg}`);
}

function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForHealthz(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
      lastError = new Error(`GET /healthz respondió ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(500);
  }
  throw new Error(`apps/api no respondió healthy en ${timeoutMs}ms en ${url}: ${lastError?.message ?? "sin detalle"}`);
}

async function main() {
  // REQ-172..180 (ronda 8a): proveedor OIDC FALSO en loopback, arrancado
  // ANTES que apps/api porque su puerto (efímero) es lo que se le pasa como
  // `OIDC_ISSUER_URL`. apps/api solo tolera `http://` contra loopback y
  // fuera de `NODE_ENV=production` (GO-03, ver
  // apps/api/src/modules/auth/google/env.ts) — ambas condiciones se cumplen
  // aquí. Ninguna credencial real de Google interviene ni puede intervenir.
  const oidc = await startBrowserFakeOidcProvider();
  log(`proveedor OIDC falso (solo pruebas) escuchando en ${oidc.issuerUrl}`);

  log(`arrancando apps/api real (PGlite en memoria) en ${API_URL}…`);
  const tsxBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
  const apiEnv = {
    ...process.env,
    PORT: String(API_PORT),
    JWT_SECRET: "e2e-ronda3-secreto-de-prueba-no-produccion",
    DATABASE_URL: "pglite://memory",
    NODE_ENV: "test",
    SKIP_MIGRATIONS: "false",
    STORAGE_DIR: path.join(WEB_ROOT, "e2e", ".artifacts", "storage"),
    CORS_ORIGINS: WEB_URL,
    PLATFORM_API_KEY,
    // Ronda 5 (apps/api): 2FA/step-up TOTP en aprobaciones económicas
    // (REQ-044/064) exige esta clave (mín. 16 caracteres) para arrancar --
    // sin ella `apps/api` ni siquiera levanta (`loadConfig` revienta antes
    // de `GET /healthz`). Literal fijo de esta suite, nunca usado fuera de
    // test:e2e:full.
    TOTP_ENCRYPTION_KEY: "e2e-totp-encryption-key-not-production",
    // REQ-181..195 (apps/api): el correo transaccional exige MAIL_LINK_SECRET
    // (mín. 16 caracteres) para firmar los enlaces de
    // verificación/invitación/restablecimiento/baja -- sin ella `loadConfig`
    // revienta igual que con TOTP_ENCRYPTION_KEY y la API ni siquiera llega a
    // `GET /healthz`. Literal fijo de esta suite, nunca usado fuera de
    // test:e2e:full. No se define `MAIL_PROVIDER` a propósito: sin ella
    // `apps/api` degrada a `CaptureProvider` (ver src/lib/mail/env.ts), así
    // que la suite NUNCA manda un correo real a Internet.
    MAIL_LINK_SECRET: "e2e-mail-link-secret-not-production",
    // REQ-181..195 (ronda 8a): apps/api activó por defecto la compuerta de
    // verificación de correo en `POST /auth/login` (403
    // `email-not-verified`). Como esta suite NO configura ningún proveedor
    // de correo real (ver `MAIL_PROVIDER` justo arriba: degrada a
    // `CaptureProvider`, en memoria y sin ningún endpoint para leer el
    // enlace capturado), el seed de e2e/global-setup.ts no tiene forma
    // honesta de confirmar los correos que él mismo registra y TODA la
    // suite quedaba bloqueada en el primer login. `false` es exactamente el
    // escape que apps/api/README.md documenta para este caso ("solo
    // mientras no haya proveedor de correo real configurado"). Consecuencia
    // asumida y explícita: esta suite NO ejercita la compuerta de
    // verificación — la pantalla de "verifica tu correo" es trabajo de la
    // ronda 8b y llegará con su propia cobertura.
    REQUIRE_EMAIL_VERIFICATION: "false",
    // `publicUrl` es la base de esos enlaces y vive donde vive apps/web
    // (nunca la URL de esta API), así que apunta al front de esta corrida.
    PUBLIC_URL: WEB_URL,
    // WI-05 (docs/auditoria-2/web-integrado.md): `test:e2e:full` recorre
    // ~29 rutas seguidas en `e2e/skip-link.spec.ts` (ALL_NAV_ITEMS), cada
    // una disparando varias peticiones de arranque de sesión — con el
    // límite global "default" de apps/api (100/min hasta ronda 3, 300/min
    // desde ronda 4) esto podía autoinducir un 429 real y hacer fallar la
    // suite por una condición de carrera de la propia orquestación, no por
    // una regresión de producto (ver rubro 1 de la auditoría). Literal
    // exacto "e2e" (ver apps/api/src/config.ts / lib/rate-limit-settings.ts):
    // nunca se activa por accidente vía NODE_ENV ni ningún otro valor, y
    // NUNCA debe usarse fuera de este harness — eleva los límites órdenes
    // de magnitud por encima de cualquier tráfico legítimo real.
    RATE_LIMIT_PROFILE: "e2e",
    // REQ-172..180: credenciales de prueba del proveedor OIDC falso de
    // arriba. Sin ellas `/auth/google/start` respondería 503 (REQ-178) y
    // e2e/google-login.spec.ts no tendría nada real que recorrer. Literales
    // fijos de esta suite: NUNCA son credenciales de Google.
    GOOGLE_CLIENT_ID: "e2e-fake-oidc-client-id",
    GOOGLE_CLIENT_SECRET: "e2e-fake-oidc-client-secret",
    // El `redirect_uri` es donde aterriza el NAVEGADOR de vuelta del
    // proveedor: la PANTALLA de la SPA (`/auth/google/callback`,
    // src/pages/auth/GoogleCallbackPage.tsx), que a su vez llama al endpoint
    // homónimo de apps/api con `code`/`state`. Nunca apunta a apps/api
    // directo — ese endpoint responde JSON, no una pantalla.
    GOOGLE_REDIRECT_URI: `${WEB_URL}/auth/google/callback`,
    OIDC_ISSUER_URL: oidc.issuerUrl,
  };

  const apiProcess = spawn(tsxBin, [path.join(API_ROOT, "src", "index.ts")], {
    cwd: API_ROOT,
    env: apiEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiProcess.stdout.on("data", (chunk) => process.stdout.write(`[api] ${chunk}`));
  apiProcess.stderr.on("data", (chunk) => process.stderr.write(`[api] ${chunk}`));

  let exitCode = 1;
  try {
    await waitForHealthz(API_URL, 30_000);
    log("apps/api lista (GET /healthz → 200).");

    log(`corriendo build + Playwright contra ${API_URL} (web servido en ${WEB_URL})…`);
    // VITE_API_URL se deja VACÍO a propósito (no `API_URL`): apps/api tiene
    // un bug real de CORS (`access-control-allow-methods: GET,HEAD,POST`,
    // sin PUT/DELETE/PATCH — ver vite.config.ts y docs/logs/web-ronda3.log)
    // que el navegador bloquea en cualquier escritura cross-origin real. Con
    // VITE_API_URL vacío, el cliente (src/lib/api/http.ts) usa rutas
    // relativas al propio origen del front, y vite.config.ts las proxea
    // server-a-server hacia `E2E_API_URL` (sin que el navegador vea nunca
    // una petición cross-origin, evitando el bug sin tocar apps/api).
    // Ronda 8a: los argumentos extra se reenvían a Playwright
    // (`npm run -w apps/web test:e2e:full -- --grep "Google"`), imprescindible
    // para iterar sobre UNA suite sin pagar los varios minutos de las 90+
    // pruebas. Sin argumentos el comportamiento es idéntico al de antes.
    const extraArgs = process.argv.slice(2);
    const { code } = await runChild("npm", ["run", "test:e2e", ...(extraArgs.length > 0 ? ["--", ...extraArgs] : [])], {
      cwd: WEB_ROOT,
      env: {
        ...process.env,
        VITE_API_URL: "",
        E2E_API_URL: API_URL,
        PLAYWRIGHT_PORT: String(WEB_PORT),
        // Leída por e2e/global-setup.ts para sembrar la convocatoria real
        // (mismo valor que `apiEnv.PLATFORM_API_KEY` arriba).
        PLATFORM_API_KEY,
        // Leída por e2e/google-login.spec.ts para decirle al proveedor
        // falso QUÉ identidad debe devolver en el próximo `/authorize`
        // (ver scripts/fake-oidc-server.mjs). Sin esta variable ese spec
        // se salta entero en vez de fingir que probó el flujo.
        E2E_OIDC_CONTROL_URL: oidc.controlUrl,
      },
    });
    exitCode = code ?? 1;
  } finally {
    log("apagando apps/api y el proveedor OIDC falso…");
    apiProcess.kill("SIGTERM");
    await delay(200);
    if (!apiProcess.killed) apiProcess.kill("SIGKILL");
    await oidc.close().catch(() => undefined);
  }

  log(exitCode === 0 ? "test:e2e:full OK." : `test:e2e:full FALLÓ (exit ${exitCode}).`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[test:e2e:full] error fatal:", err);
  process.exit(1);
});
