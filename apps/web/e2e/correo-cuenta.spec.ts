import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Locator } from "@playwright/test";

import { test, expect } from "./fixtures";
import { createSeedClient } from "./seed-client";
import { capturedMails, capturedMailsTo, mailCaptureFile, waitForMailLink } from "./mail-capture";
import type { SeedData } from "./global-setup";

// ESM real ("type": "module" en package.json): sin `__dirname` global.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_URL = process.env.E2E_API_URL;
const PASSWORD = "ContraseñaSeguraE2E123";

function leerSeed(): SeedData | null {
  if (!API_URL) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, ".artifacts", "seed.json"), "utf8")) as SeedData;
  } catch {
    return null;
  }
}

/**
 * Escribe en un campo y NO sigue hasta comprobar que el valor se quedó.
 *
 * Hace falta de verdad, no es paranoia: varias de estas pantallas se
 * alcanzan por navegación de cliente (un clic en un enlace de react-router),
 * y `waitForURL` resuelve en cuanto cambia la URL — antes de que llegue el
 * chunk `React.lazy` de la ruta y de que `react-hook-form` monte sus campos
 * controlados. Un `fill()` en esa ventana deja el input pintado pero con el
 * valor descartado por el primer render controlado, y el formulario se envía
 * VACÍO (reproducido en vivo: la corrida falló con "Ingresa tu correo
 * electrónico." sobre un campo que el test creía lleno).
 */
async function escribir(campo: Locator, valor: string): Promise<void> {
  await expect(async () => {
    await campo.fill(valor);
    await expect(campo).toHaveValue(valor, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

function correoUnico(prefijo: string): string {
  return `e2e-${prefijo}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}@atiende.test`;
}

/**
 * REQ-181/186/196 (ronda 8b): los flujos de correo de cuenta recorridos en
 * un navegador REAL contra `apps/api` real, con la compuerta de
 * verificación ENCENDIDA (`REQUIRE_EMAIL_VERIFICATION=true`, ver
 * scripts/e2e-full.mjs).
 *
 * Ningún enlace se construye aquí: cada uno se LEE del correo que la propia
 * API renderizó y dejó en su bandeja de captura (`MAIL_CAPTURE_FILE`,
 * variable documentada de apps/api — ver e2e/mail-capture.ts). Si esa
 * bandeja no está configurada, esta suite se salta entera en vez de fingir
 * que probó algo.
 *
 * LÍMITE DECLARADO (no cubierto aquí, y no se inventa): la baja de un clic
 * (`/preferencias/baja`) necesita un enlace firmado que solo viaja en el pie
 * de las plantillas OPCIONALES, y todas las que dispara `apps/api` hoy son
 * de seguridad de cuenta (obligatorias, sin `unsubscribeUrl` por diseño).
 * Quien manda las opcionales sería `apps/worker`, fuera del alcance de
 * apps/web. Esa pantalla queda cubierta por sus pruebas de componente con
 * MSW (src/pages/PreferenciasBajaPage.test.tsx), incluidas las
 * adversariales.
 */
test.describe("Correo de cuenta (ronda 8b)", () => {
  test.skip(!API_URL || !mailCaptureFile(), "Requiere test:e2e:full (apps/api real + bandeja de captura de correo).");

  test("REQ-181: la compuerta bloquea el login sin confirmar, el reenvío funciona y el enlace real desbloquea", async ({
    noAuthPage: page,
  }) => {
    const client = createSeedClient(API_URL!);
    const email = correoUnico("compuerta");
    await client.register(email, PASSWORD);

    // 1. Contraseña CORRECTA, correo sin confirmar -> 403 `email-not-verified`.
    //    La pantalla no dice "credenciales inválidas" (sería mentira): manda
    //    al aviso de confirmación.
    await page.goto("/login");
    await escribir(page.getByLabel("Correo electrónico"), email);
    await escribir(page.getByLabel("Contraseña"), PASSWORD);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();

    await page.waitForURL("**/revisa-tu-correo");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Confirma tu correo para entrar");
    await expect(page.getByText("Tu contraseña es correcta", { exact: false })).toBeVisible();

    // 2. Reenvío REAL: la API vuelve a emitir un correo de verificación.
    const antes = capturedMailsTo(email).length;
    await page.getByRole("button", { name: "Reenviar enlace de confirmación" }).click();
    await expect(page.getByText("Si esa cuenta existe y aún no está confirmada", { exact: false })).toBeVisible();
    await expect.poll(() => capturedMailsTo(email).length, { timeout: 15_000 }).toBeGreaterThan(antes);

    // 3. El enlace REAL del correo confirma la cuenta.
    const enlace = await waitForMailLink(email, "/verificar-correo");
    await page.goto(enlace);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Listo, tu correo quedó confirmado");

    // 4. Ahora el MISMO login entra. Sin organizaciones todavía, la sesión
    //    aterriza en /sin-acceso (D-09), que es el destino correcto.
    await page.getByRole("link", { name: "Iniciar sesión" }).click();
    await page.waitForURL("**/login");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Accede a tu panel de licitaciones");
    await escribir(page.getByLabel("Correo electrónico"), email);
    await escribir(page.getByLabel("Contraseña"), PASSWORD);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.waitForURL("**/sin-acceso");
  });

  test("REQ-181 adversarial: reabrir el enlace de confirmación ya consumido lo rechaza", async ({ noAuthPage: page }) => {
    const client = createSeedClient(API_URL!);
    const email = correoUnico("reuso");
    await client.register(email, PASSWORD);

    const enlace = await waitForMailLink(email, "/verificar-correo");
    await page.goto(enlace);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Listo, tu correo quedó confirmado");

    // Segundo uso del MISMO enlace: la firma sigue siendo válida, pero el
    // token es de un solo uso en la base (consumo atómico) -- falla ahí.
    await page.goto(enlace);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Este enlace ya no sirve");
    await expect(page.getByRole("button", { name: "Reenviar enlace de confirmación" })).toBeVisible();
  });

  test("REQ-186: recuperación de contraseña de punta a punta, y el enlace no sirve dos veces", async ({ noAuthPage: page }) => {
    const client = createSeedClient(API_URL!);
    const email = correoUnico("recuperacion");
    await client.register(email, PASSWORD);

    // Cuenta confirmada por el camino real antes de empezar.
    await page.goto(await waitForMailLink(email, "/verificar-correo"));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Listo, tu correo quedó confirmado");

    // 1. Se pide el enlace desde la pantalla pública.
    await page.goto("/login");
    await page.getByRole("link", { name: "¿Olvidaste tu contraseña?" }).click();
    await page.waitForURL("**/recuperar-contrasena");
    // Esperar al <h1> de la pantalla NUEVA, no solo a la URL: con
    // `React.lazy` la URL cambia antes de que llegue el chunk de la ruta, y
    // /login todavía pintado tiene un campo con la MISMA etiqueta ("Correo
    // electrónico") -- sin esta espera se escribía en el formulario viejo y
    // la recuperación se enviaba vacía (reproducido en vivo, dos corridas).
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("¿Olvidaste tu contraseña?");
    await escribir(page.getByLabel("Correo electrónico"), email);
    await page.getByRole("button", { name: "Enviarme el enlace" }).click();
    await expect(page.getByText("Si existe una cuenta con ese correo", { exact: false })).toBeVisible();

    // 2. Se abre el enlace REAL del correo y se elige contraseña nueva.
    const enlace = await waitForMailLink(email, "/restablecer-contrasena");
    const nueva = "OtraContraseñaE2E456";
    await page.goto(enlace);
    await escribir(page.getByLabel("Contraseña nueva", { exact: true }), nueva);
    await escribir(page.getByLabel("Repite la contraseña nueva"), nueva);
    await page.getByRole("button", { name: "Guardar contraseña nueva" }).click();
    await page.waitForURL("**/login");

    // 3. ADVERSARIAL: el mismo enlace, otra vez. La firma no venció, pero el
    //    token ya se consumió: la API responde su único 400 genérico.
    await page.goto(enlace);
    await escribir(page.getByLabel("Contraseña nueva", { exact: true }), "UnaTerceraE2E789");
    await escribir(page.getByLabel("Repite la contraseña nueva"), "UnaTerceraE2E789");
    await page.getByRole("button", { name: "Guardar contraseña nueva" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Este enlace ya no sirve");

    // 4. La contraseña NUEVA entra (y la vieja ya no: la API la reemplazó).
    await page.goto("/login");
    await escribir(page.getByLabel("Correo electrónico"), email);
    await escribir(page.getByLabel("Contraseña"), nueva);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.waitForURL("**/sin-acceso");
  });

  test("REQ-186: la invitación por enlace firmado sobrevive al login intermedio", async ({ noAuthPage: page }) => {
    const seed = leerSeed();
    test.skip(!seed, "Requiere el seed de global-setup.ts.");

    const client = createSeedClient(API_URL!);
    const email = correoUnico("invitado");
    await client.register(email, PASSWORD);
    await page.goto(await waitForMailLink(email, "/verificar-correo"));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Listo, tu correo quedó confirmado");

    // Organización DEDICADA a esta prueba: invitar a orgA/orgB alteraría los
    // supuestos de membresías que ya verifican otras suites.
    const adminTokens = await client.login(seed!.admin.email, seed!.admin.password);
    const runId = Date.now().toString(36);
    const org = await client.createOrganization(adminTokens.accessToken, `E2E Org Invitacion ${runId}`, `e2e-org-inv-${runId}`);
    await client.inviteMember(adminTokens.accessToken, org.id, email, "writer");

    // El enlace lo emitió apps/api dentro del correo de invitación.
    const enlace = await waitForMailLink(email, "/invitaciones/aceptar");

    // Sin sesión: la pantalla NO acepta nada (la API exige que el correo de
    // la sesión coincida) y ofrece entrar conservando el enlace.
    await page.goto(enlace);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Entra o crea tu cuenta para aceptarla");
    await page.getByRole("link", { name: "Ya tengo cuenta: iniciar sesión" }).click();
    await page.waitForURL("**/login");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Accede a tu panel de licitaciones");

    await escribir(page.getByLabel("Correo electrónico"), email);
    await escribir(page.getByLabel("Contraseña"), PASSWORD);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();

    // Vuelve a la MISMA URL, con su query firmada intacta (redirectAfterAuth):
    // sin conservar el `?d=…&s=…` no habría invitación que aceptar.
    await page.waitForURL("**/invitaciones/aceptar?*");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ya eres parte de la organización");
    await expect(page.getByText('Tu rol es "writer"', { exact: false })).toBeVisible();

    // La membresía es real: el panel ya es alcanzable (antes rebotaría a /sin-acceso).
    await page.getByRole("link", { name: "Ir al panel" }).click();
    await page.waitForURL("**/panel");
  });

  test("REQ-196: el formulario de contacto de la landing crea el registro y dispara el correo interno", async ({
    noAuthPage: page,
  }) => {
    const mensaje = `Obra pública federal en Jalisco (E2E ${Date.now().toString(36)}).`;

    await page.goto("/");
    await escribir(page.getByLabel("Nombre"), "Ana Pérez");
    await escribir(page.getByLabel("Correo de trabajo"), correoUnico("contacto"));
    await escribir(page.getByLabel("Empresa (opcional)"), "Constructora Ana");
    await escribir(page.getByLabel(/convocatorias te interesan/), mensaje);
    await page.getByRole("button", { name: "Enviar solicitud" }).click();

    await expect(page.getByText("Recibimos tu mensaje.")).toBeVisible();

    // El correo INTERNO (plantilla `contact-received`) salió de verdad: se
    // busca por el texto del mensaje, no por el buzón, para no atarse al
    // valor por defecto de `CONTACT_INBOX`.
    await expect
      .poll(() => capturedMails().filter((mail) => mail.text.includes(mensaje)).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
  });
});
