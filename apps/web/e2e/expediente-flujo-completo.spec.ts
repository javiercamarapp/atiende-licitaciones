import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";
import { seriousOrCriticalViolations, formatViolations } from "./utils/a11y";
import { getAdminStepUpCode, completeStepUp } from "./two-factor-helpers";
import type { SeedData } from "./global-setup";

// ESM real ("type": "module" en package.json): sin `__dirname` global.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ronda 5: recorrido de negocio COMPLETO del expediente de participación,
// contra apps/api real (npm run test:e2e:full): documento de bases → matriz
// de requisitos → propuesta técnica/económica → checklist de integridad →
// revisión/aprobación (dos actores: `writer` solicita, `admin` aprueba) →
// paquete "borrador" → completar el expediente → paquete "listo" →
// descarga autenticada → declaración de presentación. Además: A11 (editar
// tras aprobar invalida y el paquete vuelve a "borrador"), A12 (writer no
// puede aprobar) y A14 (paquete incompleto nunca "listo").
//
// Corre en la organización C del seed (e2e/global-setup.ts), dedicada
// exclusivamente a esta suite con una convocatoria real ya sembrada por
// `POST /internal/tenders/ingest` — aislada de orgA/orgB para no interferir
// con los supuestos de ronda3-flujo-real.spec.ts (writer ve orgA vacía) ni
// de recorrido.spec.ts (paquete de la organización por defecto sin
// convocatorias).
test.skip(!process.env.E2E_API_URL, "requiere `npm run test:e2e:full` (arranca apps/api real con seed)");

const ARTIFACTS_DIR = path.resolve(__dirname, ".artifacts");

function readSeed(): SeedData {
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, "seed.json"), "utf8")) as SeedData;
}

const runId = Date.now().toString(36);
const SIGNER_ROLE_TITLE = `representante_legal_${runId}`;
const RATE_ITEM_CODE = `E2E-EXP-${runId}`;
// "poder notarial" es literal a propósito: `extractRequiredEvidence`
// (packages/expediente/src/requirement-matrix.ts) solo llena
// `requiredEvidence` para un puñado de frases reconocidas (fianza,
// garantía, opinión de cumplimiento/32-D, acta constitutiva, poder
// notarial, anexos, o requisitos económicos). Un requisito con
// `requiredEvidence` VACÍO nunca llega a la rama de mapeo explícito de
// `TechnicalProposalBuilder` -- queda "PENDIENTE" SIEMPRE, sin importar
// qué mapeo declare esta prueba (encontrado real corriendo
// test:e2e:full: la frase original, sin "poder notarial", dejaba el
// requisito bloqueado pese al mapeo).
const BASES_SENTENCE = `El licitante deberá contar con un representante legal ${runId} acreditado mediante poder notarial para firmar la propuesta.`;

async function switchOrganization(page: import("@playwright/test").Page, orgName: string) {
  await page.goto("/panel");
  const switcher = page.getByRole("combobox", { name: "Organización" });
  if (!(await switcher.innerText()).includes(orgName)) {
    await switcher.click();
    await page.getByRole("option", { name: new RegExp(orgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  }
  await expect(switcher).toContainText(orgName);
}

async function selectTender(page: import("@playwright/test").Page, tenderTitle: string) {
  const combo = page.getByRole("combobox", { name: "Convocatoria" });
  await combo.click();
  await page.getByRole("option", { name: tenderTitle }).click();
}

// REQ-044/064: `getAdminStepUpCode`/`completeStepUp` viven en
// ./two-factor-helpers.ts (compartidas con ronda3-flujo-real.spec.ts). El
// enrolamiento de 2FA de `admin` ocurre UNA SOLA VEZ en e2e/global-setup.ts
// (2FA es de CUENTA, no de organización) -- los specs solo calculan un
// código TOTP vigente en el momento de cada step-up.

test.describe.serial("Expediente — flujo completo real (ronda 5)", () => {
  // REQ-044/064 (R5-02): `POST /auth/2fa/step-up` comparte con `/enroll` y
  // `/verify-enrollment` un límite de tasa FIJO de 5 peticiones/5min por IP,
  // nunca relajado ni siquiera por `RATE_LIMIT_PROFILE=e2e` (ver
  // apps/api/src/lib/rate-limit-settings.ts) -- esta suite ya comparte esa
  // IP con ronda3-flujo-real.spec.ts (mismo worker en modo "full") y usa 2
  // de esos 5 cupos para sus propios step-up reales (aprobar tarifa,
  // aprobar expediente). Reintentar un test de aquí que involucre step-up
  // no arregla un límite de tasa real -- solo gastaría más presupuesto y
  // arriesgaría tumbar los cupos restantes de esta MISMA corrida. Se
  // desactivan los reintentos para todo este archivo.
  test.describe.configure({ retries: 0 });

  test("preparación: admin agrega un firmante autorizado en la organización C", async ({ page }) => {
    const seed = readSeed();
    test.skip(!seed.tender, "PLATFORM_API_KEY no configurada: sin convocatoria sembrada");
    await switchOrganization(page, seed.orgC.name);

    await page.goto("/empresa/firmantes-autorizados");
    await page.getByLabel("Nombre completo").fill(`Representante Legal E2E ${runId}`);
    await page.getByLabel("Cargo (opcional)").fill(SIGNER_ROLE_TITLE);
    await page.getByRole("button", { name: "Agregar" }).click();
    await expect(page.getByText(SIGNER_ROLE_TITLE)).toBeVisible();
  });

  test("preparación: admin propone y aprueba una tarifa con step-up 2FA (dato real para la propuesta económica)", async ({ page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    await page.goto("/empresa/tarifas-aprobadas");
    await page.getByLabel("Código").fill(RATE_ITEM_CODE);
    await page.getByLabel("Descripción").fill("Servicio de consultoría E2E");
    await page.getByLabel("Precio unitario (MXN)").fill("15000");
    await page.getByRole("button", { name: "Proponer" }).click();
    await expect(page.getByText(RATE_ITEM_CODE)).toBeVisible();

    const row = page.getByRole("row", { name: new RegExp(RATE_ITEM_CODE) });
    await row.getByRole("button", { name: "Aprobar" }).click();
    await completeStepUp(page, await getAdminStepUpCode(seed));
    await expect(row.getByText("Aprobada")).toBeVisible();
  });

  test("Análisis de bases: sube el documento y construye la matriz de requisitos (sin OCR necesario)", async ({ page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    await page.goto("/evaluacion/analisis-bases");
    await selectTender(page, seed.tender!.title);

    const fileInput = page.getByLabel("Archivo (PDF de preferencia)");
    await fileInput.setInputFiles({
      name: "bases-e2e.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(BASES_SENTENCE, "utf8"),
    });
    await page.getByRole("button", { name: "Subir" }).click();
    await expect(page.getByText("bases-e2e.txt")).toBeVisible();
    await expect(page.getByText("Texto extraído")).toBeVisible();

    await page.getByRole("tab", { name: "Matriz de requisitos" }).click();
    await page.getByRole("button", { name: "Recalcular matriz de requisitos" }).click();
    await expect(page.getByText(new RegExp(`representante legal ${runId}`))).toBeVisible();

    const violations = await seriousOrCriticalViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  test("A14: el paquete nunca aparece \"Listo\" con el expediente todavía incompleto", async ({ page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    // `POST .../package/assemble` exige que el expediente (fila `proposals`)
    // ya exista -- a diferencia de `GET /proposal`, no lo autocrea (404
    // explícito real, ver apps/api/src/lib/expediente/context.ts
    // `requireProposal`). Visitar Redacción primero dispara `GET /proposal`
    // (que SÍ autocrea el expediente en estado "draft", sin secciones
    // todavía) sin generar nada -- exactamente el caso "incompleto" que A14
    // debe cubrir. Espera la respuesta REAL (no solo el `goto`): sin esto,
    // una navegación demasiado rápida a Entrega podía dejar la página
    // anterior antes de que `GET .../proposal` terminara de autocrear el
    // expediente, y `POST .../package/assemble` seguía viendo un 404 real
    // de "expediente inexistente" en vez del "incompleto" que A14 cubre.
    await page.goto("/preparacion/redaccion");
    const proposalAutoCreated = page.waitForResponse(
      (res) => /\/expediente\/tenders\/.+\/proposal$/.test(res.url()) && res.request().method() === "GET",
      { timeout: 15_000 },
    );
    await selectTender(page, seed.tender!.title);
    await proposalAutoCreated;

    await page.goto("/entrega/paquete-descargable");
    await selectTender(page, seed.tender!.title);
    await page.getByRole("button", { name: "Ensamblar paquete" }).click();

    await expect(page.getByText("Borrador", { exact: true })).toBeVisible();
    await expect(page.getByText("Listo para presentar")).toHaveCount(0);
  });

  test("Redacción: genera la propuesta técnica mapeando el requisito a un dato real de empresa", async ({ page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    await page.goto("/preparacion/redaccion");
    await selectTender(page, seed.tender!.title);

    await page.getByRole("button", { name: "Agregar mapeo" }).click();
    // `{ exact: true }`: RedaccionPage.tsx también tiene un combobox
    // "Requisito relacionado" (sección económica) -- el `name` de
    // Playwright hace match por subcadena por defecto, así que sin
    // `exact` ambos calzan y rompe en "strict mode" cuando los dos están
    // en el DOM a la vez.
    await page.getByRole("combobox", { name: "Requisito", exact: true }).click();
    await page.getByRole("option", { name: new RegExp(`representante legal ${runId}`) }).click();

    await page.getByRole("combobox", { name: "Tipo de fuente" }).click();
    await page.getByRole("option", { name: "Firmante autorizado" }).click();

    await page.getByRole("combobox", { name: "Dato de empresa" }).click();
    await page.getByRole("option", { name: SIGNER_ROLE_TITLE }).click();

    await page.getByRole("button", { name: "Generar propuesta técnica" }).click();
    await expect(page.getByText(/Propuesta técnica generada/)).toBeVisible();
    await expect(page.getByText("Bloqueado / pendiente")).toHaveCount(0);
  });

  test("Redacción: genera la propuesta económica con la tarifa aprobada (sin conceptos bloqueados)", async ({ page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    await page.goto("/preparacion/redaccion");
    await selectTender(page, seed.tender!.title);

    await page.getByRole("combobox", { name: "Concepto" }).click();
    await page.getByRole("option", { name: new RegExp(RATE_ITEM_CODE) }).click();

    await page.getByRole("button", { name: "Generar propuesta económica" }).click();
    await expect(page.getByText(/Propuesta económica generada/)).toBeVisible();
    await expect(page.getByText("Bloqueado / pendiente")).toHaveCount(0);

    const violations = await seriousOrCriticalViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  test("Cumplimiento documental: ejecuta el checklist de integridad real y queda en verde", async ({ page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    await page.goto("/preparacion/cumplimiento-documental");
    await selectTender(page, seed.tender!.title);
    await page.getByRole("button", { name: "Ejecutar checklist" }).click();

    await expect(page.getByText("General: Verde")).toBeVisible();
  });

  test("Revisión: writer solicita revisión del expediente", async ({ writerPage: page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    await page.goto("/preparacion/revision");
    await selectTender(page, seed.tender!.title);
    await expect(page.getByText("Borrador", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Solicitar revisión" }).click();
    await expect(page.getByText("En revisión", { exact: true })).toBeVisible();
  });

  test("A12: el rol writer no puede aprobar el expediente (la UI ni siquiera ofrece el botón)", async ({ writerPage: page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    await page.goto("/preparacion/revision");
    await selectTender(page, seed.tender!.title);

    await expect(page.getByText(/no puede aprobar/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Aprobar expediente" })).toHaveCount(0);

    const violations = await seriousOrCriticalViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  test("admin aprueba el expediente con step-up 2FA (actor distinto de quien solicitó la revisión)", async ({ page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    await page.goto("/preparacion/revision");
    await selectTender(page, seed.tender!.title);

    await page.getByRole("button", { name: "Aprobar expediente" }).click();
    await completeStepUp(page, await getAdminStepUpCode(seed));
    await expect(page.getByText("Aprobado", { exact: true })).toBeVisible();
  });

  test('el paquete pasa a "Listo para presentar" con el expediente completo y aprobado', async ({ page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    await page.goto("/entrega/paquete-descargable");
    await selectTender(page, seed.tender!.title);
    await page.getByRole("button", { name: "Ensamblar paquete" }).click();

    await expect(page.getByText("Listo para presentar")).toBeVisible();
  });

  test("descarga autenticada del paquete listo", async ({ page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    await page.goto("/entrega/paquete-descargable");
    await selectTender(page, seed.tender!.title);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /Descargar paquete/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
  });

  test("declara la presentación del expediente (nunca se envía nada a un portal externo)", async ({ page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    await page.goto("/entrega/entregas");
    await selectTender(page, seed.tender!.title);
    await expect(page.getByText("El sistema nunca envía ni firma nada")).toBeVisible();

    const now = new Date();
    const localDatetime = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await page.getByLabel("Fecha y hora de presentación").fill(localDatetime);
    await page.getByRole("button", { name: "Declarar presentación" }).click();

    await expect(page.getByRole("heading", { name: "Presentación declarada" })).toBeVisible();
  });

  test("A11: editar una sección tras aprobar invalida la aprobación y el paquete vuelve a \"Borrador\"", async ({ page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    await page.goto("/preparacion/redaccion");
    await selectTender(page, seed.tender!.title);

    const sectionTextarea = page.getByRole("textbox", { name: /Contenido de la sección/ }).first();
    await sectionTextarea.fill((await sectionTextarea.inputValue()) + " Texto editado por la prueba A11.");
    await page.getByRole("button", { name: "Guardar nueva versión" }).first().click();
    await expect(page.getByText(/Sección actualizada/)).toBeVisible();

    await page.goto("/preparacion/revision");
    await selectTender(page, seed.tender!.title);
    await expect(page.getByText("Invalidada tras un cambio")).toBeVisible();

    // AE-14: `GET .../package/latest` re-deriva el estado ACTUAL en cada
    // lectura -- sin volver a ensamblar, el paquete ya listo antes deja de
    // reportarse "Listo" en cuanto la aprobación vigente deja de cubrir el
    // estado actual del expediente.
    await page.goto("/entrega/paquete-descargable");
    await selectTender(page, seed.tender!.title);
    await expect(page.getByText("Borrador", { exact: true })).toBeVisible();
    await expect(page.getByText("Listo para presentar")).toHaveCount(0);
  });

  test("320×568 y 390×844: Análisis de bases y Redacción sin scroll horizontal con datos reales", async ({ page }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgC.name);

    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      for (const route of ["/evaluacion/analisis-bases", "/preparacion/redaccion"]) {
        await page.goto(route);
        await selectTender(page, seed.tender!.title);
        const scroll = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(scroll.scrollWidth, `${route} @ ${viewport.width}x${viewport.height}`).toBe(scroll.clientWidth);
      }
    }
  });

  // Restaura la organización activa de `admin`/`writer` a la A: este spec
  // corre en el MISMO worker (y por tanto el MISMO contexto de navegador
  // compartido, ver e2e/fixtures.ts) que ronda3-flujo-real.spec.ts y
  // recorrido.spec.ts (modo "full" fuerza `workers: 1`, ver
  // playwright.config.ts) -- sin este último paso, si este archivo corre
  // ANTES que esos dos (el orden entre archivos de Playwright no está
  // garantizado), dejaría la organización activa en C, rompiendo sus
  // supuestos ya probados (writer ve orgA vacía; el paquete de la
  // organización por defecto de admin arranca sin convocatorias).
  test("limpieza: restaura la organización activa a A para no afectar otras suites", async ({ page, writerPage }) => {
    const seed = readSeed();
    await switchOrganization(page, seed.orgA.name);
    await switchOrganization(writerPage, seed.orgA.name);
  });
});
