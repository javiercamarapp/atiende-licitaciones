import { test, expect } from "./fixtures";
import { seriousOrCriticalViolations, formatViolations } from "./utils/a11y";

// Demo pública de solo lectura (ronda 7, REQ §34.4): datos de ejemplo
// servidos por MSW (mocks/browser.ts) SOLO en esta ruta, sobre un
// navegador real -- a diferencia de la suite unitaria (DemoPage.test.tsx,
// jsdom sin Service Workers), aquí el worker sí arranca de verdad.
test.describe("Demo de solo lectura (/demo)", () => {
  test("etiqueta los datos de ejemplo y muestra KPIs con datos ficticios", async ({ noAuthPage: page }) => {
    await page.goto("/demo");

    await expect(page.getByText(/Datos de ejemplo/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Panel de ejemplo" })).toBeVisible();
    await expect(page.getByText("Convocatorias nuevas (7 días)")).toBeVisible();
    await expect(page.getByText("Matches elegibles")).toBeVisible();
  });

  test("nunca mezcla con datos reales: el namespace /demo-api/* es propio", async ({ noAuthPage: page }) => {
    const demoApiRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/demo-api/")) demoApiRequests.push(req.url());
    });
    await page.goto("/demo");
    await expect(page.getByRole("heading", { name: "Panel de ejemplo" })).toBeVisible();
    expect(demoApiRequests.length).toBeGreaterThan(0);
    // Ninguna ruta real de apps/api (sin X-Org-Id, sin sesión) debió
    // dispararse desde esta pantalla.
    const realApiPaths = ["/tenders", "/matching", "/company", "/expediente", "/audit-log"];
    for (const path of realApiPaths) {
      const hit = demoApiRequests.some((url) => url.includes(path) && !url.includes("/demo-api/"));
      expect(hit, `no debió llamarse a ${path} fuera de /demo-api`).toBe(false);
    }
  });

  test("enlaza de vuelta a inicio y a iniciar sesión", async ({ noAuthPage: page }) => {
    await page.goto("/demo");
    await expect(page.getByRole("heading", { name: "Panel de ejemplo" })).toBeVisible();
    await page.getByRole("link", { name: /Iniciar sesión/ }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("sin violaciones serious/critical de axe", async ({ noAuthPage: page }) => {
    await page.goto("/demo");
    await expect(page.getByRole("heading", { name: "Panel de ejemplo" })).toBeVisible();
    const violations = await seriousOrCriticalViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  test("móvil 390×844: sin scroll horizontal", async ({ noAuthPage: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/demo");
    await expect(page.getByText(/Datos de ejemplo/)).toBeVisible();
    const scroll = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(scroll.scrollWidth).toBe(scroll.clientWidth);
  });
});
