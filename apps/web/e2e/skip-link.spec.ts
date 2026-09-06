import { test, expect } from "@playwright/test";

// W-09: verificado por teclado real (Tab hasta el skip-link + Enter), no
// solo por axe automatizado — axe no detecta a dónde se mueve el foco tras
// activar un enlace, solo que el enlace exista.
test.describe("Skip-link mueve el foco real (W-09)", () => {
  test("en LoginPage, el skip-link mueve el foco al formulario (#login-form)", async ({ page }) => {
    await page.goto("/login");
    // Sin esto, el primer Tab en una página recién cargada a veces no
    // mueve el foco de forma determinística en Chromium headless.
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
