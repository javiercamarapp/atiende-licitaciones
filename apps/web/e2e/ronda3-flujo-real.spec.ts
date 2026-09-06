import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";
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

const RATE_ITEM_CODE = "E2E-TARIFA-1";

test.describe.serial("Ronda 3 — recorrido real contra apps/api", () => {
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
      await page.getByRole("button", { name: "Guardar perfil" }).click();

      await expect(page.getByText(/Perfil de empresa guardado/)).toBeVisible();
      await page.reload();
      await expect(page.getByLabel("Razón social")).toHaveValue("Empresa E2E Ronda 3 S.A. de C.V.");
    });

    test("sube un documento y ve su semáforo de vigencia real", async ({ page }) => {
      await page.goto("/empresa/documentos-vigencias");
      await page.getByLabel("Tipo de documento").fill("constancia_situacion_fiscal");
      await page.locator("#document-file").setInputFiles({
        name: "documento-e2e.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Contenido de prueba E2E ronda 3 — sin datos ficticios en producción."),
      });
      await page.getByRole("button", { name: "Subir documento" }).click();

      await expect(page.getByText(/Documento subido/)).toBeVisible();
      const row = page.getByRole("row", { name: /constancia_situacion_fiscal/ });
      await expect(row).toBeVisible();
      // Sin `validUntil`, la API calcula `pending_verification` (nunca
      // "vigente" por defecto sin fecha real) — ver
      // apps/api/src/lib/storage.ts computeDocumentStatus.
      await expect(row.getByText("Pendiente de verificación")).toBeVisible();
    });
  });

  test.describe("como writer (solo miembro de la organización A)", () => {
    test("propone una tarifa, que queda en borrador (no puede aprobarla)", async ({ writerPage: page }) => {
      await page.goto("/empresa/tarifas-aprobadas");
      await page.getByLabel("Código").fill(RATE_ITEM_CODE);
      await page.getByLabel("Descripción").fill("Servicio propuesto por writer en E2E ronda 3");
      await page.getByLabel("Precio unitario (MXN)").fill("1500");
      await page.getByRole("button", { name: "Proponer" }).click();

      await expect(page.getByText(/Tarifa propuesta/)).toBeVisible();
      const row = page.getByRole("row", { name: new RegExp(RATE_ITEM_CODE) });
      await expect(row).toBeVisible();
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
    test("aprueba la tarifa propuesta por writer", async ({ page }) => {
      await page.goto("/empresa/tarifas-aprobadas");
      const row = page.getByRole("row", { name: new RegExp(RATE_ITEM_CODE) });
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Aprobar" }).click();

      await expect(page.getByText(/Tarifa aprobada/)).toBeVisible();
      await expect(row.getByText("Aprobada")).toBeVisible();
    });
  });
});
