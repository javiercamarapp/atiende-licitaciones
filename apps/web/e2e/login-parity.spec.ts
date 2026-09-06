import { test, expect } from "./fixtures";

// W-11: LoginPage debía alinearse a la anatomía real del login de
// atiende-restaurantes (pantalla partida, kicker, titular serif) — ver
// README.md § "Paridad del login con Restaurantes" para el detalle de las
// divergencias deliberadas (sin foto de cocina, sin Google OAuth).
//
// Ronda 3 (W-12): con sesión (fixture `page` por defecto, ver
// e2e/fixtures.ts), /login redirige a /panel — esta suite usa `noAuthPage`
// (sin ninguna sesión) para ver el formulario real.
test.describe("Paridad visual del login (W-11)", () => {
  test("escritorio: layout de pantalla partida con kicker, titular y lámina decorativa", async ({ noAuthPage: page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/login");

    await expect(page.getByText("Acceso al panel")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Accede a tu panel de licitaciones" })).toBeVisible();
    // La lámina decorativa es aria-hidden (puramente visual); se verifica su
    // presencia por texto, no por rol.
    await expect(page.getByText("Licitaciones públicas en México")).toBeVisible();
  });

  test("móvil (390×844): la lámina decorativa se oculta y no hay scroll horizontal", async ({ noAuthPage: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");

    await expect(page.getByText("Licitaciones públicas en México")).toBeHidden();
    const scroll = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scroll.scrollWidth).toBe(scroll.clientWidth);
  });

  // Ronda 3: se retiró la pestaña de enlace mágico (no existe ningún
  // endpoint `/auth/magic-link` en apps/api — ver LoginPage.tsx y
  // README.md). Ahora solo hay un formulario de contraseña, sin tabs.
  test("solo formulario de contraseña, sin tabs ni Google OAuth (ronda 3: se retiró enlace mágico sin backend)", async ({ noAuthPage: page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1, name: "Accede a tu panel de licitaciones" })).toBeVisible();
    await expect(page.getByLabel("Correo electrónico")).toBeVisible();
    await expect(page.getByLabel("Contraseña")).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.getByText("Continuar con Google")).toHaveCount(0);
    await expect(page.getByText(/enlace mágico/i)).toHaveCount(0);
  });
});
