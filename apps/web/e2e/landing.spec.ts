import { test, expect } from "./fixtures";
import { seriousOrCriticalViolations, formatViolations } from "./utils/a11y";

// Landing pública (ronda 7): la única pantalla, junto con /login y /demo,
// pensada para verse SIN sesión -- `noAuthPage` (sin ningún token, ver
// e2e/fixtures.ts) es el fixture correcto aquí, no el `page` por defecto
// (que llega autenticado como `admin` y redirigiría a /panel).
test.describe("Landing pública (/)", () => {
  test("muestra el hero real y navega a /demo y /login", async ({ noAuthPage: page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/licitación/i);

    await page.getByRole("link", { name: "Ver demo sin cuenta" }).click();
    await expect(page).toHaveURL(/\/demo$/);

    await page.goBack();
    await page.getByRole("link", { name: "Iniciar sesión" }).first().click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("enlaza el pie a /privacidad y /legal/terminos", async ({ noAuthPage: page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Aviso de privacidad" }).click();
    await expect(page).toHaveURL(/\/privacidad$/);

    await page.goBack();
    await page.getByRole("link", { name: "Términos de servicio" }).click();
    await expect(page).toHaveURL(/\/legal\/terminos$/);
    await expect(page.getByText("Borrador pendiente de validación jurídica")).toBeVisible();
  });

  test("escritorio (1280×800): sin violaciones serious/critical de axe", async ({ noAuthPage: page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const violations = await seriousOrCriticalViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  test("móvil 390×844: sin scroll horizontal ni violaciones serious/critical", async ({ noAuthPage: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const scroll = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(scroll.scrollWidth).toBe(scroll.clientWidth);
    const violations = await seriousOrCriticalViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  test("móvil 320×568 (el más angosto soportado): sin scroll horizontal", async ({ noAuthPage: page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/");
    const scroll = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(scroll.scrollWidth).toBe(scroll.clientWidth);
  });

  // Ronda 8b (REQ-196): el formulario ya NO está deshabilitado — `POST
  // /public/contact` existe en apps/api. El envío REAL de punta a punta
  // (registro + correo interno capturado) lo cubre e2e/correo-cuenta.spec.ts,
  // que necesita la bandeja de captura; aquí solo se comprueba que el
  // formulario está habilitado y que el honeypot sigue existiendo en el DOM
  // real del navegador (si desapareciera, la capa 2 del anti-abuso de la API
  // dejaría de servir sin que nada fallara a gritos).
  test("el formulario de solicitar demo está habilitado y conserva el honeypot", async ({ noAuthPage: page }) => {
    await page.goto("/");
    await page.getByText("Solicitar demo", { exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Enviar solicitud" })).toBeEnabled();

    const honeypot = page.locator('input[name="website"]');
    await expect(honeypot).toHaveCount(1);
    await expect(honeypot).toHaveValue("");
    await expect(honeypot).toHaveAttribute("tabindex", "-1");
  });

  test("una sesión activa redirige la landing a /panel", async ({ page }) => {
    // `page` (no `noAuthPage`): fixture ya autenticado como `admin` (ver
    // e2e/fixtures.ts) -- confirma que LandingPage.tsx no se queda mostrando
    // la propuesta de valor a alguien que ya tiene sesión.
    await page.goto("/");
    await page.waitForURL("**/panel");
    await expect(page.getByRole("navigation", { name: "Navegación principal" })).toBeVisible();
  });
});
