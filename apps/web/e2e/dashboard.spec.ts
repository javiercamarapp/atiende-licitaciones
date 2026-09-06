import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";
import type { SeedData } from "./global-setup";
import { seriousOrCriticalViolations, formatViolations } from "./utils/a11y";

// ESM real ("type": "module" en package.json): sin `__dirname` global.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.resolve(__dirname, ".artifacts");

test.skip(!process.env.E2E_API_URL, "requiere `npm run test:e2e:full` (arranca apps/api real con seed)");

function readSeed(): SeedData {
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, "seed.json"), "utf8")) as SeedData;
}

// Panel/Dashboard real (ronda 7, REQ-169): orgD del seed (ver
// e2e/global-setup.ts) trae una convocatoria REAL sembrada vía
// `POST /internal/tenders/ingest` -- nunca datos ficticios en el frontend.
// `admin` (fixture `page`, ver e2e/fixtures.ts) ya es owner de orgD desde
// el arranque.
test.describe.serial("Panel/Dashboard real (REQ-169)", () => {
  test("muestra KPIs reales calculados sobre la convocatoria sembrada de orgD", async ({ page }) => {
    const seed = readSeed();
    test.skip(!seed.dashboardTender, "requiere PLATFORM_API_KEY (ver scripts/e2e-full.mjs) para sembrar la convocatoria del dashboard");

    await page.goto("/panel");
    const switcher = page.getByRole("combobox", { name: "Organización" });
    await switcher.click();
    await page.getByRole("option", { name: new RegExp(seed.orgD.name) }).click();
    await expect(switcher).toContainText(seed.orgD.name);

    // La convocatoria se ingirió hace instantes (createdAt real de apps/api,
    // no un valor fijo del frontend) -- cae dentro de la ventana de 7 días.
    const newTendersCard = page.getByText("Convocatorias nuevas (7 días)").locator("..");
    await expect(newTendersCard.getByText("1", { exact: true })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Checklist de activación")).toBeVisible();
    await expect(page.getByText("Primera convocatoria disponible para revisar")).toBeVisible();

    // `getByRole("link", { name: "Descubrimiento" })` a secas es ambiguo: la
    // sidebar (fuera de este componente, ver components/layout/SidebarNav.tsx)
    // también tiene un enlace con el mismo nombre accesible -- se acota al
    // `<nav aria-label="Accesos rápidos">` real de PanelPage.tsx.
    const quickLinks = page.getByRole("navigation", { name: "Accesos rápidos" });
    await expect(quickLinks).toBeVisible();
    await quickLinks.getByRole("link", { name: "Descubrimiento" }).click();
    await expect(page).toHaveURL(/\/convocatorias\/descubrimiento$/);
    await expect(page.getByText(seed.dashboardTender!.title)).toBeVisible();
  });

  test("sin violaciones serious/critical de axe, y deja la organización activa de vuelta en orgA", async ({ page }) => {
    const seed = readSeed();
    await page.goto("/panel");
    const violations = await seriousOrCriticalViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);

    // Cortesía con el resto de la suite (mismo patrón que
    // ronda3-flujo-real.spec.ts): el contexto de `admin` es COMPARTIDO por
    // todo el worker (ver e2e/fixtures.ts) -- sin este restablecimiento,
    // cualquier spec posterior que asuma la organización por defecto
    // (orgA, sin convocatorias) heredaría en su lugar orgD.
    const switcher = page.getByRole("combobox", { name: "Organización" });
    if (!(await switcher.innerText()).includes(seed.orgA.name)) {
      await switcher.click();
      await page.getByRole("option", { name: new RegExp(seed.orgA.name) }).click();
      await expect(switcher).toContainText(seed.orgA.name);
    }
  });
});
