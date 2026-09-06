import { test, expect } from "./fixtures";

// W-09: verificado por teclado real (Tab hasta el skip-link + Enter), no
// solo por axe automatizado — axe no detecta a dónde se mueve el foco tras
// activar un enlace, solo que el enlace exista.
test.describe("Skip-link mueve el foco real (W-09)", () => {
  test("en LoginPage, el skip-link mueve el foco al formulario (#login-form)", async ({ page }) => {
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
