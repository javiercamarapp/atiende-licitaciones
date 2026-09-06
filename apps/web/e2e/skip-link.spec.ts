import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

import { ALL_NAV_ITEMS } from "../src/config/navigation";

interface FocusStyleSnapshot {
  outlineStyle: string;
  outlineColor: string;
  boxShadow: string;
}

async function leerEstiloDe(page: Page, selector: string): Promise<FocusStyleSnapshot> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { outlineStyle: "(sin elemento)", outlineColor: "", boxShadow: "" };
    const style = window.getComputedStyle(el);
    return { outlineStyle: style.outlineStyle, outlineColor: style.outlineColor, boxShadow: style.boxShadow };
  }, selector);
}

/**
 * W-18: axe-core no detecta "foco invisible" (no existe una regla fiable
 * para eso), así que se compara `getComputedStyle` del elemento ANTES de
 * enfocarlo (línea base, que puede incluir una sombra ambiental permanente
 * como `shadow-card` en `<main>`, sin relación con el foco) contra DESPUÉS
 * de enfocarlo por teclado real. Un indicador de foco es visible si aparece
 * un `outline` con color/estilo real (no `rgba(0, 0, 0, 0)`/`transparent`,
 * el valor exacto que producía `focus:outline-none` sin reemplazo, el bug
 * original) o si el `boxShadow` CAMBIA respecto a la línea base — comparar
 * solo "boxShadow !== 'none'" daría un falso negativo/positivo en `<main>`,
 * que siempre tiene `shadow-card` puesto o no.
 */
function outlineEsVisible(s: FocusStyleSnapshot): boolean {
  return s.outlineStyle !== "none" && s.outlineColor !== "rgba(0, 0, 0, 0)" && s.outlineColor !== "transparent";
}

async function focoEsVisible(
  page: Page,
  selector: string,
  baseline: FocusStyleSnapshot,
): Promise<{ visible: boolean; outline: string; boxShadow: string; boxShadowBaseline: string }> {
  const focused = await leerEstiloDe(page, selector);
  const visible = outlineEsVisible(focused) || focused.boxShadow !== baseline.boxShadow;
  return {
    visible,
    outline: `${focused.outlineStyle} ${focused.outlineColor}`,
    boxShadow: focused.boxShadow,
    boxShadowBaseline: baseline.boxShadow,
  };
}

// Ronda 3 (W-12): con sesión (fixture `page` por defecto, ver
// e2e/fixtures.ts), /login redirige a /panel — la prueba de esta suite que
// necesita el formulario real de LoginPage usa `noAuthPage` (el resto de la
// suite sí necesita sesión, para llegar a /panel y a las 24 rutas de
// ALL_NAV_ITEMS).
test.describe("Skip-link mueve el foco real (W-09)", () => {
  test("en LoginPage (sin sesión), el skip-link mueve el foco al formulario (#login-form)", async ({ noAuthPage: page }) => {
    await page.goto("/login");
    // LoginPage carga una fuente externa (Fraunces, ver login.css); sin
    // esperar a que la red esté quieta, el primer Tab puede llegar antes de
    // que Chromium headless termine de asentar el orden de foco de la
    // página, y el foco se queda en <body>.
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.body.focus());

    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Saltar al formulario de acceso" });
    await expect(skipLink).toBeFocused();

    await page.keyboard.press("Enter");

    const loginForm = page.locator("#login-form");
    await expect(loginForm).toBeFocused();
  });

  test("en AppShell, el skip-link mueve el foco al contenido principal (#main-content)", async ({ page }) => {
    await page.goto("/panel");
    await page.evaluate(() => document.body.focus());

    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Saltar al contenido principal" });
    await expect(skipLink).toBeFocused();

    await page.keyboard.press("Enter");

    const main = page.locator("#main-content");
    await expect(main).toBeFocused();
  });
});

// W-18: el foco llegaba correctamente (W-09) pero era invisible en las 25
// pantallas del portal (24 rutas autenticadas + login) por `focus:outline-none`
// sin ningún reemplazo. Parametrizado sobre las mismas 24 rutas que
// `recorrido.spec.ts` (ALL_NAV_ITEMS) más /login.
test.describe("Foco visible tras activar el skip-link (W-18)", () => {
  test("en LoginPage (sin sesión), el foco en #login-form es visible (outline/box-shadow reales)", async ({ noAuthPage: page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    const baseline = await leerEstiloDe(page, "#login-form");
    await page.evaluate(() => document.body.focus());

    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");

    await expect(page.locator("#login-form")).toBeFocused();
    const { visible, outline, boxShadow, boxShadowBaseline } = await focoEsVisible(page, "#login-form", baseline);
    expect(visible, `outline: ${outline} · boxShadow: ${boxShadow} (línea base: ${boxShadowBaseline})`).toBe(true);
  });

  for (const item of ALL_NAV_ITEMS) {
    test(`en ${item.label} (${item.to}), el foco en #main-content es visible (outline/box-shadow reales)`, async ({
      page,
    }) => {
      await page.goto(item.to);
      const baseline = await leerEstiloDe(page, "#main-content");
      await page.evaluate(() => document.body.focus());

      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");

      await expect(page.locator("#main-content")).toBeFocused();
      const { visible, outline, boxShadow, boxShadowBaseline } = await focoEsVisible(page, "#main-content", baseline);
      expect(visible, `outline: ${outline} · boxShadow: ${boxShadow} (línea base: ${boxShadowBaseline})`).toBe(true);
    });
  }
});
