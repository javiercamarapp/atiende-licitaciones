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

  // W-19: W-10 corrigió el botón hamburguesa y los 24 enlaces de navegación
  // del drawer, pero no los botones de acordeón de cada grupo ("EMPRESA",
  // "CONVOCATORIAS", etc., SidebarNav.tsx) — medían 31px de alto. Se miden
  // TODOS los controles interactivos del drawer (los botones de grupo y los
  // enlaces), no solo el primero, a 390×844.
  test("todos los botones de acordeón de grupo del drawer móvil miden al menos 44px de alto", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/panel");

    await page.getByRole("button", { name: "Abrir menú de navegación" }).click();
    const dialog = page.getByRole("dialog");

    // `[aria-expanded]` selecciona solo los botones de acordeón de grupo
    // (SidebarNav.tsx) y excluye el botón "Cerrar menú" del Sheet (sin
    // aria-expanded, fuera de ámbito de W-19).
    const groupButtons = dialog.locator("button[aria-expanded]");
    const count = await groupButtons.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const button = groupButtons.nth(i);
      const label = (await button.textContent())?.trim() ?? `botón #${i}`;
      const box = await button.boundingBox();
      expect(box, `botón de grupo "${label}" sin boundingBox`).not.toBeNull();
      expect(box!.height, `botón de grupo "${label}": ${box!.height}px de alto`).toBeGreaterThanOrEqual(MIN_TARGET);
    }
  });

  test("todos los controles interactivos del drawer móvil (grupos + enlaces) miden al menos 44px de alto", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/panel");

    await page.getByRole("button", { name: "Abrir menú de navegación" }).click();
    const dialog = page.getByRole("dialog");

    const links = dialog.getByRole("link");
    const linkCount = await links.count();
    expect(linkCount).toBeGreaterThan(0);
    for (let i = 0; i < linkCount; i++) {
      const link = links.nth(i);
      const label = (await link.textContent())?.trim() ?? `link #${i}`;
      const box = await link.boundingBox();
      expect(box, `link "${label}" sin boundingBox`).not.toBeNull();
      expect(box!.height, `link "${label}": ${box!.height}px de alto`).toBeGreaterThanOrEqual(MIN_TARGET);
    }
  });
});
