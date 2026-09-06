import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";
import { getAdminStepUpCode } from "./two-factor-helpers";
import type { SeedData } from "./global-setup";

// ESM real ("type": "module" en package.json): sin `__dirname` global.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Recorrido de negocio de ronda 3, CONTRA LA API REAL levantada con PGlite
// (npm run test:e2e:full → apps/web/scripts/e2e-full.mjs arranca apps/api,
// e2e/global-setup.ts siembra dos organizaciones + dos usuarios REALES
// llamando a la propia API — nada de esto es un dato ficticio en el
// frontend): login → cambiar organización → crear perfil → subir documento
// → proponer tarifa (writer) → aprobar (admin) → ver convocatorias vacías
// honestas → admin 403 para usuario normal en back office.
//
// La identidad de cada test viene del fixture: `page` (por defecto,
// autenticada como `admin`), `writerPage` (autenticada como `writer`) o
// `noAuthPage` (sin ninguna sesión) — ver e2e/fixtures.ts para el porqué de
// NO usar un `storageState` estático (el refresh token de apps/api rota con
// un solo uso; un archivo estático reutilizado por varios contextos
// rompería para todos menos el primero).
//
// Sin `E2E_API_URL` (npm run test:e2e a secas, sin backend), este archivo
// completo se salta: no hay seed que leer.
test.skip(!process.env.E2E_API_URL, "requiere `npm run test:e2e:full` (arranca apps/api real con seed)");

const ARTIFACTS_DIR = path.resolve(__dirname, ".artifacts");

function readSeed(): SeedData {
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, "seed.json"), "utf8")) as SeedData;
}

// Generado por test (no una constante fija): `approved_rates` tiene un
// UNIQUE(org_id, item_code) real en apps/api — si un reintento de Playwright
// (ver playwright.config.ts, `retries` en modo "full") vuelve a correr todo
// el `describe.serial` desde el principio, un código fijo colisionaría con
// la fila que ya quedó de un intento anterior (409 al proponer, o aprobando
// la fila equivocada). Se declara aquí (module scope) pero se ASIGNA dentro
// de la propia prueba que la propone, así cada intento real usa un valor
// nuevo.
let rateItemCode = "";

test.describe.serial("Ronda 3 — recorrido real contra apps/api", () => {
  // REQ-044/064 (R5-02): `POST /auth/2fa/step-up` (como `/enroll` y
  // `/verify-enrollment`) comparte un límite de tasa FIJO de 5
  // peticiones/5min POR IP, nunca relajado ni siquiera por
  // `RATE_LIMIT_PROFILE=e2e` (ver apps/api/src/lib/rate-limit-settings.ts,
  // docstring "R5-02: NUNCA se relaja") -- una medida anti-fuerza-bruta
  // deliberada, fuera del alcance de apps/web. Esta suite ya gasta 2 de esas
  // 5 peticiones en el enrolamiento de global-setup.ts; reintentar un test
  // de este archivo que involucre step-up NO arregla un límite de tasa real
  // (solo gastaría más presupuesto y arriesgaría tumbar los intentos
  // restantes de esta MISMA corrida, incluidos los de
  // expediente-flujo-completo.spec.ts, que corre en el mismo worker/IP) --
  // se desactivan los reintentos para todo este archivo.
  test.describe.configure({ retries: 0 });

  test("login con credenciales reales del seed redirige a /panel", async ({ noAuthPage: page }) => {
    const seed = readSeed();
    await page.goto("/login");
    await page.getByLabel("Correo electrónico").fill(seed.admin.email);
    await page.getByLabel("Contraseña").fill(seed.admin.password);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();

    await page.waitForURL("**/panel");
    await expect(page.getByRole("navigation", { name: "Navegación principal" })).toBeVisible();
  });

  test.describe("como admin (owner de ambas organizaciones del seed)", () => {
    test("cambia de organización con el selector real (X-Org-Id)", async ({ page }) => {
      const seed = readSeed();
      await page.goto("/panel");

      const switcher = page.getByRole("combobox", { name: "Organización" });
      await expect(switcher).toContainText(seed.orgA.name);

      await switcher.click();
      await page.getByRole("option", { name: new RegExp(seed.orgB.name) }).click();
      await expect(switcher).toContainText(seed.orgB.name);

      // Vuelve a la organización A: los siguientes pasos (perfil, documento,
      // tarifa) deben quedar en la organización de la que `writer` sí es
      // miembro (ver e2e/global-setup.ts).
      await switcher.click();
      await page.getByRole("option", { name: new RegExp(seed.orgA.name) }).click();
      await expect(switcher).toContainText(seed.orgA.name);
    });

    test("crea el perfil real de la empresa en la organización A", async ({ page }) => {
      // Bajo carga sostenida de la suite completa (muchas rutas seguidas
      // contra una apps/api real con límite de tasa, ver
      // src/lib/api/http.ts), esta escritura puede tardar más que el resto.
      test.setTimeout(60_000);
      const seed = readSeed();
      await page.goto("/panel");
      // Asegura organización A (por si el orden de ejecución cambiara).
      const switcher = page.getByRole("combobox", { name: "Organización" });
      if (!(await switcher.innerText()).includes(seed.orgA.name)) {
        await switcher.click();
        await page.getByRole("option", { name: new RegExp(seed.orgA.name) }).click();
      }

      await page.goto("/empresa/perfil-capacidades");
      await page.getByLabel("Razón social").fill("Empresa E2E Ronda 3 S.A. de C.V.");
      const saveResponse = page.waitForResponse(
        (res) => res.url().includes("/company/profile") && res.request().method() === "PUT",
        { timeout: 40_000 },
      );
      await page.getByRole("button", { name: "Guardar perfil" }).click();
      // Espera la respuesta REAL del PUT (no el toast, que Sonner
      // auto-descarta y que, bajo el reintento de 429 de
      // src/lib/api/http.ts, ronda3-README, podría desaparecer antes de que
      // la aserción lo viera): recargar antes de que el PUT resuelva
      // simplemente releería el perfil viejo, dando un falso "no se guardó".
      const response = await saveResponse;
      expect(response.ok(), `PUT /company/profile respondió ${response.status()}`).toBe(true);

      await page.reload();
      await expect(page.getByLabel("Razón social")).toHaveValue("Empresa E2E Ronda 3 S.A. de C.V.", { timeout: 15_000 });
    });

    test("sube un documento y ve su semáforo de vigencia real", async ({ page }) => {
      // Sufijo único por ejecución (no una constante fija): si un reintento
      // de Playwright vuelve a correr todo el `describe.serial`, un nombre
      // fijo dejaría DOS filas con el mismo tipo (no hay UNIQUE en
      // company_documents, pero sí rompería el locator en "strict mode" al
      // encontrar dos filas que calzan).
      const documentType = `constancia_situacion_fiscal_${Date.now()}`;
      await page.goto("/empresa/documentos-vigencias");
      await page.getByLabel("Tipo de documento").fill(documentType);
      // WI-02: el `<input type="file">` ahora valida tipo/tamaño en cliente
      // (ver validateDocumentFile.ts) antes de leer el archivo — un `.txt`
      // ya no pasaría esa validación, así que este fixture usa un PDF
      // mínimo pero estructuralmente válido (header %PDF- + marcador
      // %%EOF, lo mismo que exige apps/api/src/lib/storage.ts del lado del
      // servidor cuando un archivo se presenta como PDF).
      await page.locator("#document-file").setInputFiles({
        name: "documento-e2e.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF"),
      });
      await page.getByRole("button", { name: "Subir documento" }).click();

      // Igual que el perfil: se verifica el resultado duradero (la fila real
      // en la tabla), no el toast transitorio.
      const row = page.getByRole("row", { name: new RegExp(documentType) });
      await expect(row).toBeVisible({ timeout: 15_000 });
      // Sin `validUntil`, la API calcula `pending_verification` (nunca
      // "vigente" por defecto sin fecha real) — ver
      // apps/api/src/lib/storage.ts computeDocumentStatus.
      await expect(row.getByText("Pendiente de verificación")).toBeVisible();
    });

    // WI-02 (docs/auditoria-2/web-integrado.md / REQ-098): antes de esta
    // corrección, el cliente no rechazaba nada — el archivo se codificaba a
    // base64 y se enviaba por red siempre, sin importar tipo/tamaño.
    test("rechaza en el cliente un archivo de e.firma sin llegar a enviarlo por red (REQ-098)", async ({ page }) => {
      await page.goto("/empresa/documentos-vigencias");
      await page.getByLabel("Tipo de documento").fill(`efirma-rechazada_${Date.now()}`);

      let uploadRequestSeen = false;
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("/company/documents")) uploadRequestSeen = true;
      });

      await page.locator("#document-file").setInputFiles({
        name: "llave-privada.key",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("-----BEGIN PRIVATE KEY-----\nfalso-para-la-prueba\n-----END PRIVATE KEY-----"), // check-secrets:allow-fixture
      });

      await expect(page.getByText(/REQ-098|e\.firma/)).toBeVisible({ timeout: 5_000 });
      expect(uploadRequestSeen, "no debe llegar a enviarse POST /company/documents").toBe(false);
    });
  });

  test.describe("como writer (solo miembro de la organización A)", () => {
    test("propone una tarifa, que queda en borrador (no puede aprobarla)", async ({ writerPage: page }) => {
      rateItemCode = `E2E-TARIFA-${Date.now()}`;
      await page.goto("/empresa/tarifas-aprobadas");
      await page.getByLabel("Código").fill(rateItemCode);
      await page.getByLabel("Descripción").fill("Servicio propuesto por writer en E2E ronda 3");
      await page.getByLabel("Precio unitario (MXN)").fill("1500");
      await page.getByRole("button", { name: "Proponer" }).click();

      const row = page.getByRole("row", { name: new RegExp(rateItemCode) });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row.getByText("Propuesta (borrador)")).toBeVisible();
      // writer no ve columna de acciones de aprobación (MEMBERSHIP_ADMIN_ROLES only).
      await expect(page.getByRole("button", { name: "Aprobar" })).toHaveCount(0);
    });

    test("ve convocatorias vacías honestas (sin datos ficticios)", async ({ writerPage: page }) => {
      await page.goto("/convocatorias/descubrimiento");
      await expect(page.getByText("Aún no hay convocatorias")).toBeVisible();
    });

    test("recibe un 403 honesto de la API al entrar a back office (no es superadmin)", async ({ writerPage: page }) => {
      await page.goto("/backoffice/organizaciones");
      const alert = page.getByRole("alert");
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(/superadmin/i);
    });
  });

  test.describe("como admin (aprueba lo que propuso writer)", () => {
    // REQ-044/064 (ronda 5): aprobar exige X-Step-Up. El enrolamiento de 2FA
    // de `admin` ocurre UNA SOLA VEZ en e2e/global-setup.ts (proceso único,
    // inmune a reintentos de Playwright) -- aquí solo se calcula un código
    // TOTP vigente en el momento del step-up (ver two-factor-helpers.ts).
    //
    // WI-06 (docs/auditoria-2/reverificacion-final-integrada.md) va
    // fusionado en ESTA MISMA prueba (antes eran dos: una aprobación simple
    // y un ataque de doble clic sobre una segunda tarifa dedicada) -- el
    // límite de tasa de `/auth/2fa/step-up` (5 peticiones/5min por IP,
    // nunca relajado, ver arriba) no alcanza para dos verificaciones TOTP
    // reales independientes en esta suite sin arriesgar 429 reales en el
    // resto de los flujos con step-up (ver expediente-flujo-completo.spec.ts).
    // Desde que aprobar exige step-up, "Aprobar" en la fila solo abre el
    // modal (sin red) -- el punto real de doble envío es "Verificar y
    // continuar" dentro de StepUpDialog. Un doble clic FÍSICO real (dos
    // gestos `page.mouse.click()` reales, disparados con `Promise.all` sin
    // `await` entre ellos -- no `dispatchEvent`/JS sintético) ahí debía
    // disparar 2 peticiones de red reales antes de la reparación del guard
    // síncrono en TarifasAprobadasPage.tsx. Verifica de una sola vez: (a) la
    // tarifa real queda "Aprobada", (b) contra el servidor real, se dispara
    // UNA sola petición `POST .../rates/:id/approve` (no dos), (c) ningún
    // toast de error aparece (ni el 409 honesto de WI-04, que sí aparecería
    // si el guard cliente dejara pasar un segundo POST real).
    test("aprueba la tarifa propuesta por writer con step-up 2FA, resistiendo un doble clic físico en \"Verificar y continuar\" (WI-06)", async ({ page }) => {
      test.setTimeout(60_000);
      const seed = readSeed();
      await page.goto("/empresa/tarifas-aprobadas");
      const row = page.getByRole("row", { name: new RegExp(rateItemCode) });
      await expect(row).toBeVisible();

      const approveRequests: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && /\/rates\/.+\/approve$/.test(request.url())) {
          approveRequests.push(request.url());
        }
      });

      await row.getByRole("button", { name: "Aprobar" }).click();
      await page.getByLabel("Código TOTP o de respaldo").fill(await getAdminStepUpCode(seed));
      const verifyButton = page.getByRole("button", { name: "Verificar y continuar" });
      const box = await verifyButton.boundingBox();
      if (!box) throw new Error('No se pudo obtener la posición de "Verificar y continuar" para el doble clic físico');
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;

      const firstResponse = page.waitForResponse(
        (res) => res.url().includes("/rates/") && res.url().includes("/approve") && res.request().method() === "POST",
        { timeout: 40_000 },
      );

      // Dos clics físicos reales en las MISMAS coordenadas, disparados con
      // `Promise.all` sin `await` entre ellos -- `page.mouse.click()` (a
      // diferencia de `locator.click()`) no repite ningún chequeo de
      // "actionability": si el guard cliente deshabilita/retira el botón
      // entre el primer clic y el segundo, `locator.click()` se queda
      // reintentando esperar a que vuelva a estar "enabled" (nunca ocurre,
      // porque la fila ya cambió de estado) hasta agotar el timeout -- esto
      // es lo más cercano a dos eventos de clic físico verdaderamente
      // simultáneos del navegador real, sin depender de que Playwright
      // considere "accionable" al elemento en el segundo clic.
      await Promise.all([page.mouse.click(x, y), page.mouse.click(x, y)]);
      const response = await firstResponse;
      expect(response.ok(), `POST .../rates/:id/approve respondió ${response.status()}`).toBe(true);

      await expect(row.getByText("Aprobada")).toBeVisible({ timeout: 10_000 });

      // Margen para que una segunda petición espuria (si el guard fallara)
      // alcance a llegar antes de contar.
      await page.waitForTimeout(1_000);
      expect(approveRequests.length, `peticiones POST .../approve observadas: ${approveRequests.length}`).toBe(1);

      // Ningún toast de error (ni el 409 honesto de WI-04, que aparecería si
      // el guard cliente hubiera dejado pasar un segundo POST real).
      await expect(page.getByText(/ya cambió de estado/)).toHaveCount(0);
    });
  });
});
