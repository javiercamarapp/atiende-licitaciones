import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";
import { createSeedClient } from "./seed-client";
import { mailCaptureFile, waitForMailLink } from "./mail-capture";
import type { SeedData } from "./global-setup";
import { seriousOrCriticalViolations, formatViolations } from "./utils/a11y";

// ESM real ("type": "module" en package.json): sin `__dirname` global.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.resolve(__dirname, ".artifacts");

function readSeedApiUrl(): string {
  const seed = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, "seed.json"), "utf8")) as SeedData;
  return seed.apiUrl;
}

// Onboarding completo tras el PRIMER login de una cuenta nueva (ronda 7):
// requiere apps/api real para registrar un usuario limpio, sin ninguna
// organización todavía -- ninguna identidad del seed de global-setup.ts
// sirve aquí (`admin`/`writer` ya son miembros de orgA/orgB/orgC/orgD desde
// el arranque).
//
// Ronda 8b (REQ-181): `test:e2e:full` arranca la API con
// `REQUIRE_EMAIL_VERIFICATION=true` (scripts/e2e-full.mjs), así que una
// cuenta recién registrada YA NO entra a /login sin más -- ver más abajo,
// se confirma con el enlace real de la bandeja de captura antes de intentar
// el login. Sin esa bandeja (`E2E_MAIL_CAPTURE_FILE`) no hay forma honesta
// de confirmarla, así que la prueba se salta en vez de fingir.
test.skip(!process.env.E2E_API_URL, "requiere `npm run test:e2e:full` (arranca apps/api real)");
test.skip(!mailCaptureFile(), "requiere la bandeja de captura de correo (E2E_MAIL_CAPTURE_FILE) para confirmar la cuenta");

test.describe("Onboarding: primer login sin organizaciones", () => {
  test("wizard completo hasta el checklist real del panel", async ({ noAuthPage: page }) => {
    test.setTimeout(60_000);
    const apiUrl = readSeedApiUrl();
    const client = createSeedClient(apiUrl);
    const runId = Date.now().toString(36);
    const email = `e2e-onboarding-${runId}@atiende.test`;
    const password = "ContraseñaSeguraE2E123";
    await client.register(email, password);

    // REQ-181: confirma el correo con el enlace REAL que la API dejó en su
    // bandeja de captura, server-a-server -- este spec prueba el onboarding
    // posterior al login, no la pantalla de verificación (esa la cubre
    // e2e/correo-cuenta.spec.ts).
    const enlace = await waitForMailLink(email, "/verificar-correo");
    const params = new URL(enlace).searchParams;
    await client.verifyEmail({ d: params.get("d")!, s: params.get("s")! });

    await page.goto("/login");
    await page.getByLabel("Correo electrónico").fill(email);
    await page.getByLabel("Contraseña").fill(password);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();

    // RequireOrganization (components/auth/RequireAuth.tsx) manda directo
    // aquí: una cuenta sin ninguna organización no tiene nada real que ver
    // en /panel. Ronda 8 (D-09): la compuerta pasa PRIMERO por /sin-acceso
    // (mismo patrón SIN_ROL/`/sin-acceso` de Likida, ahora también para
    // cuentas de email+contraseña, no solo Google) -- "Crear mi
    // organización" entra al wizard existente, que arranca igual que antes.
    await page.waitForURL("**/sin-acceso");
    await expect(page.getByRole("heading", { level: 1, name: "Tu cuenta no está vinculada a ninguna organización" })).toBeVisible();
    await page.getByRole("link", { name: "Crear mi organización" }).click();

    await page.waitForURL("**/onboarding");
    await expect(page.getByRole("heading", { level: 1, name: "Bienvenido a Atiende Licitaciones" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Crea tu organización" })).toBeVisible();

    // El toast de "Sesión iniciada correctamente." (Sonner) sigue en su
    // transición de entrada (400ms, `opacity`/`transform`) justo después del
    // login -- `toBeVisible()` no exige que esa transición haya terminado.
    // Escanear con axe a mitad de esa transición mide un color de texto
    // MEZCLADO (opacity parcial), un "serious" de contraste real pero
    // espurio (mismo hallazgo que b9da17b en expediente-flujo-completo.spec.ts).
    await page.waitForTimeout(500);

    const violations = await seriousOrCriticalViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);

    // Paso 1: crear organización (POST /organizations real).
    const orgName = `Empresa Onboarding ${runId}`;
    await page.getByLabel("Nombre de la organización").fill(orgName);
    await page.getByRole("button", { name: "Crear organización y continuar" }).click();

    // Paso 2: perfil de empresa esencial (PUT /company/profile real).
    await expect(page.getByRole("heading", { level: 2, name: "Perfil de empresa esencial" })).toBeVisible();
    await page.getByLabel("Razón social").fill(`${orgName} S.A. de C.V.`);
    await page.getByLabel("RFC").fill("EOB800101ABC");
    await page.getByLabel("Giro / sector").fill("Consultoría");
    await page.getByRole("button", { name: "Guardar y continuar" }).click();

    // Paso 3: invitar equipo (opcional, se omite).
    await expect(page.getByRole("heading", { level: 2, name: "Invita a tu equipo" })).toBeVisible();
    await page.getByRole("button", { name: "Omitir por ahora" }).click();

    // Paso 4: primer documento (opcional, se omite).
    await expect(page.getByRole("heading", { level: 2, name: "Sube tu primer documento" })).toBeVisible();
    await page.getByRole("button", { name: "Omitir por ahora" }).click();

    // Paso 5: listo.
    await expect(page.getByRole("heading", { level: 2, name: "Tu organización está lista" })).toBeVisible();
    await page.getByRole("button", { name: "Ir al panel" }).click();

    await page.waitForURL("**/panel");
    await expect(page.getByRole("combobox", { name: "Organización" })).toContainText(orgName);

    // Checklist de activación (hooks/useActivationChecklist.ts) refleja el
    // hecho real ya guardado: el perfil (razón social + RFC) queda marcado,
    // el resto (documento, tarifa, convocatoria, 2FA) sigue pendiente en una
    // organización recién creada.
    await expect(page.getByText("Checklist de activación")).toBeVisible();
    await expect(page.getByText("1 de 5 pasos completados.")).toBeVisible();
    await expect(page.getByText("Perfil de empresa completo (razón social y RFC)")).toBeVisible();
  });
});
