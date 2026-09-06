import { test, expect } from "./fixtures";

// W-10: el botón hamburguesa medía 40×40px y el primer link del drawer
// móvil 36px de alto — por debajo del objetivo de ≥44×44px recomendado
// para objetivos táctiles (WCAG 2.5.5 / Android Material, best practice).
const MIN_TARGET = 44;

test.describe("Objetivos táctiles ≥44×44px (W-10)", () => {
  test("el botón hamburguesa mide al menos 44×44px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/panel");

    const hamburger = page.getByRole("button", { name: "Abrir menú de navegación" });
    const box = await hamburger.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TARGET);
  });

  test("el primer link del drawer móvil mide al menos 44px de alto", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/panel");

    await page.getByRole("button", { name: "Abrir menú de navegación" }).click();
    const dialog = page.getByRole("dialog");
    const firstLink = dialog.getByRole("link").first();
    const box = await firstLink.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TARGET);
  });
});
