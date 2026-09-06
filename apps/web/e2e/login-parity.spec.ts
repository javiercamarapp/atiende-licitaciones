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
  // README.md). Ronda 8a: "Continuar con Google" SÍ aparece ahora, porque
  // apps/api ya tiene el flujo OIDC real detrás (`/auth/google/start`,
  // REQ-172) — esta prueba afirmaba lo contrario desde ronda 3 y quedó
  // obsoleta al implementarlo. El criterio de fondo no cambió y es el que
  // se sigue verificando: en /login solo hay métodos con backend REAL
  // detrás, nunca una pestaña decorativa.
  test("métodos de acceso con backend real: contraseña + Google, sin tabs ni enlace mágico", async ({ noAuthPage: page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1, name: "Accede a tu panel de licitaciones" })).toBeVisible();
    await expect(page.getByLabel("Correo electrónico")).toBeVisible();
    await expect(page.getByLabel("Contraseña")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continuar con Google" })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.getByText(/enlace mágico/i)).toHaveCount(0);
  });
});
