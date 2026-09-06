import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test, expect } from "./fixtures";
import type { SeedData } from "./global-setup";
import { getAdminStepUpCode } from "./two-factor-helpers";

// ESM real ("type": "module" en package.json): sin `__dirname` global.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(__dirname, ".artifacts", "seed.json");

/**
 * REQ-172..180 / D-09: login con Google recorrido de VERDAD en un navegador
 * real, contra apps/api real y contra el proveedor OIDC falso de loopback
 * que arranca `scripts/e2e-full.mjs` (ver `scripts/fake-oidc-server.mjs`).
 * Ni una sola petición sale a Internet ni existe ninguna credencial real de
 * Google en juego: `OIDC_ISSUER_URL` apunta a `http://127.0.0.1:<puerto>`,
 * la única excepción `http://` que apps/api tolera (GO-03).
 *
 * A diferencia de las pruebas de componente (src/pages/auth/
 * GoogleCallbackPage.test.tsx, con MSW), aquí el navegador NAVEGA de verdad
 * al proveedor y este lo redirige de vuelta a `GOOGLE_REDIRECT_URI` — el
 * único modo de comprobar que el intercambio PKCE real, la consumición del
 * `state` y la pantalla de callback encajan de punta a punta.
 *
 * Sin `E2E_OIDC_CONTROL_URL` (es decir, `npm run test:e2e` a secas, sin la
 * orquestación de `test:e2e:full`) esta suite se SALTA entera en vez de
 * fingir que probó el flujo.
 */
const controlUrl = process.env.E2E_OIDC_CONTROL_URL;

function readSeed(): SeedData | null {
  if (!process.env.E2E_API_URL) return null;
  try {
    return JSON.parse(fs.readFileSync(SEED_PATH, "utf8")) as SeedData;
  } catch {
    return null;
  }
}

/**
 * Le dice al proveedor OIDC falso QUÉ identidad debe devolver en el próximo
 * `/authorize`. Un IdP real mostraría aquí la pantalla de consentimiento con
 * la sesión de Google del usuario; en la suite ese "quién soy" lo fija el
 * test, explícitamente, antes de cada clic.
 */
async function setNextGoogleIdentity(identity: { sub: string; email: string; emailVerified?: boolean }): Promise<void> {
  const response = await fetch(controlUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(identity),
  });
  if (!response.ok) {
    throw new Error(`El proveedor OIDC falso rechazó la identidad (${response.status}): ${await response.text()}`);
  }
}

test.describe("Login con Google contra apps/api real (REQ-172..180, D-09)", () => {
  test.skip(!controlUrl, "Requiere `npm run -w apps/web test:e2e:full` (proveedor OIDC falso + apps/api real).");

  test("cuenta de Google nueva: login → /sin-acceso → crear organización → panel", async ({ noAuthPage: page }) => {
    const runId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    // Correo JAMÁS registrado antes: apps/api crea la cuenta en este primer
    // login (REQ-172) y, al no tener ninguna organización, devuelve
    // `sin_acceso` (D-09) en vez de inventar una con datos que Google no
    // aporta (ni razón social ni RFC).
    await setNextGoogleIdentity({ sub: `google-sub-${runId}`, email: `e2e-google-${runId}@atiende.test` });

    await page.goto("/login");
    await page.getByRole("button", { name: "Continuar con Google" }).click();

    // El navegador se va al proveedor, este redirige de vuelta a la pantalla
    // de callback, y esa pantalla resuelve la compuerta `sin_acceso`.
    await page.waitForURL("**/sin-acceso");
    await expect(page.getByRole("heading", { level: 1, name: "Tu cuenta no está vinculada a ninguna organización" })).toBeVisible();

    // D-09: la organización se crea con el nombre REAL que teclea el
    // usuario en el wizard, nunca con datos derivados del perfil de Google.
    await page.getByRole("link", { name: "Crear mi organización" }).click();
    await page.waitForURL("**/onboarding");
    await expect(page.getByRole("heading", { level: 2, name: "Crea tu organización" })).toBeVisible();

    const orgName = `Constructora E2E Google ${runId}`;
    await page.getByLabel("Nombre de la organización").fill(orgName);
    await page.getByRole("button", { name: "Crear organización y continuar" }).click();

    // `POST /orgs` real: a partir de aquí la cuenta YA tiene membresía, así
    // que el panel deja de estar bloqueado por RequireOrganization.
    await expect(page.getByRole("heading", { level: 2, name: "Crea tu organización" })).toBeHidden();
    await page.goto("/panel");
    await page.waitForURL("**/panel");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // La compuerta ya no rebota a /sin-acceso: la membresía es real.
    expect(new URL(page.url()).pathname).toBe("/panel");
  });

  test("REQ-176: una cuenta existente con 2FA enrolado exige el segundo factor antes de completar el login con Google", async ({
    noAuthPage: page,
  }) => {
    const seed = readSeed();
    test.skip(!seed, "Sin seed de e2e/global-setup.ts no hay ninguna cuenta con 2FA real que probar.");

    // `admin` del seed: cuenta creada por email+contraseña y con 2FA
    // enrolado+verificado en global-setup.ts. Vincular una identidad de
    // Google a ese MISMO correo es el caso de REQ-176 (`auth.google_linked`
    // respetando el 2FA ya existente) — nunca un bypass del segundo factor.
    const runId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    await setNextGoogleIdentity({ sub: `google-sub-admin-${runId}`, email: seed!.admin.email });

    await page.goto("/login");
    await page.getByRole("button", { name: "Continuar con Google" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Verificación en dos pasos" })).toBeVisible();
    // Adversarial primero: un código incorrecto NO abre la sesión.
    await page.getByLabel("Código TOTP o de respaldo").fill("000000");
    await page.getByRole("button", { name: "Verificar y continuar" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Verificación en dos pasos" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/auth/google/callback");

    // Y ahora el código real: `getAdminStepUpCode` garantiza un "time step"
    // TOTP estrictamente posterior al ya consumido, para no chocar con la
    // protección anti-replay real de apps/api (ver two-factor-helpers.ts).
    const code = await getAdminStepUpCode(seed!);
    await page.getByLabel("Código TOTP o de respaldo").fill(code);
    await page.getByRole("button", { name: "Verificar y continuar" }).click();

    // `admin` sí tiene organizaciones, así que la respuesta es `ok` y el
    // destino es el panel (no la compuerta `sin_acceso`).
    await page.waitForURL("**/panel");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("adversarial: un `state` inventado nunca abre sesión (se consumió, expiró o jamás existió)", async ({ noAuthPage: page }) => {
    await page.goto("/auth/google/callback?code=codigo-inventado&state=state-que-nunca-existio");

    // El mensaje lo pone apps/api (400 real de `oauth_states`), no el
    // frontend: la pantalla solo lo muestra tal cual.
    await expect(page.getByRole("heading", { level: 1, name: "Iniciando sesión con Google" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Volver al inicio de sesión" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/auth/google/callback");
  });
});
