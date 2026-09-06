import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

import { ALL_NAV_ITEMS } from "../src/config/navigation";

// W-14 (REQ-049/REQ-065): recorridos esenciales del portal con Playwright +
// axe-core sobre el navegador real, sirviendo el build de producción
// (`vite preview`, ver playwright.config.ts) — no jsdom (ver W-13).

async function sinViolacionesSeriasOCriticas(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const graves = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(graves, JSON.stringify(graves, null, 2)).toEqual([]);
}

async function sinScrollHorizontal(page: Page) {
  const scroll = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scroll.scrollWidth).toBe(scroll.clientWidth);
}

// Ronda 3 (W-12): casi todo el árbol de rutas exige sesión real
// (RequireAuth). El fixture `page` por defecto ya llega autenticado como
// `admin` (login fresco por worker, ver e2e/fixtures.ts) para que el resto
// de specs de este archivo no tengan que repetir el login manualmente. Esta
// comprobación puntual SÍ necesita un contexto SIN sesión (`noAuthPage`,
// para ver el formulario real, no la redirección).
test.describe("Login sin sesión (W-14/ronda 3)", () => {
  test("/login muestra el formulario real cuando no hay sesión", async ({ noAuthPage: page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1, name: "Accede a tu panel de licitaciones" })).toBeVisible();
    await expect(page.getByLabel("Correo electrónico")).toBeVisible();
  });
});

test.describe("Recorrido esencial (W-14)", () => {
  test("shell: con sesión, /panel muestra el AppShell completo", async ({ page }) => {
    await page.goto("/panel");
    await expect(page.getByRole("navigation", { name: "Navegación principal" })).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
  });

  for (const item of ALL_NAV_ITEMS) {
    test(`grupo del sidebar: ${item.label} (${item.to}) carga sin violaciones serious/critical`, async ({ page }) => {
      await page.goto(item.to);
      await expect(page).toHaveURL(new RegExp(item.to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
      await sinViolacionesSeriasOCriticas(page);
    });
  }

  test("drawer móvil (390×844): se abre, comparte SidebarNav y no hay scroll horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/panel");
    await sinScrollHorizontal(page);

    await page.getByRole("button", { name: "Abrir menú de navegación" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("navigation", { name: "Navegación principal" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Panel" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("tema oscuro: activa .dark en <html> y el panel sigue sin violaciones serious/critical", async ({ page }) => {
    await page.goto("/panel");
    await page.getByRole("radio", { name: "Tema oscuro" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.waitForTimeout(300); // asienta transition-colors (ver e2e/contraste.spec.ts)
    await sinViolacionesSeriasOCriticas(page);
  });

  test("Fuentes y frescura: expone los 5 estados de fuente sin violaciones serious/critical", async ({ page }) => {
    await page.goto("/convocatorias/fuentes-frescura");
    for (const label of ["OK", "Caída", "CAPTCHA", "Cambio de interfaz", "Permisos faltantes"]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await sinViolacionesSeriasOCriticas(page);
  });

  test('Paquete descargable: arranca en "Borrador", nunca en "Listo", sin violaciones serious/critical', async ({
    page,
  }) => {
    await page.goto("/entrega/paquete-descargable");
    await expect(page.getByText("Borrador", { exact: true })).toBeVisible();
    await expect(page.getByText("Listo para presentar")).toHaveCount(0);
    await expect(page.getByText("La presentación y firma las realiza el usuario")).toBeVisible();
    await sinViolacionesSeriasOCriticas(page);
  });

  test("todas las rutas del sidebar: sin scroll horizontal a 390×844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const item of ALL_NAV_ITEMS) {
      await page.goto(item.to);
      await sinScrollHorizontal(page);
    }
  });
});
