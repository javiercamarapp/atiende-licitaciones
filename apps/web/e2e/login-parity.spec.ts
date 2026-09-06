import { test, expect } from "./fixtures";

// W-11: LoginPage debía alinearse a la anatomía real del login de
// atiende-restaurantes (pantalla partida, kicker, titular serif) — ver
// README.md § "Paridad del login con Restaurantes" para el detalle de las
// divergencias deliberadas (sin foto de cocina, con tabs contraseña/enlace
// mágico en vez de solo Google OAuth).
test.describe("Paridad visual del login (W-11)", () => {
  test("escritorio: layout de pantalla partida con kicker, titular y lámina decorativa", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/login");

    await expect(page.getByText("Acceso al panel")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Accede a tu panel de licitaciones" })).toBeVisible();
    // La lámina decorativa es aria-hidden (puramente visual); se verifica su
    // presencia por texto, no por rol.
    await expect(page.getByText("Licitaciones públicas en México")).toBeVisible();
  });

  test("móvil (390×844): la lámina decorativa se oculta y no hay scroll horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");

    await expect(page.getByText("Licitaciones públicas en México")).toBeHidden();
    const scroll = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scroll.scrollWidth).toBe(scroll.clientWidth);
  });

  test("mantiene contraseña + enlace mágico (divergencia deliberada: sin Google OAuth)", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("tab", { name: "Contraseña" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Enlace mágico/ })).toBeVisible();
    await expect(page.getByText("Continuar con Google")).toHaveCount(0);
  });
});
