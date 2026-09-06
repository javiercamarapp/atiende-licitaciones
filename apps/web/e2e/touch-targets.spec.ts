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

  // W-22 (docs/auditoria-1/web-reverificacion-2.md): el disparador de
  // OrganizationSwitcher (36px de alto) y el botón "Cerrar menú" del drawer
  // (28×28px) no quedaban cubiertos por W-10 (enlaces + hamburguesa) ni por
  // W-19 (botones de acordeón de grupo). Se comprueban a 320×568 (además de
  // 390×844, el único viewport que probaba la ronda anterior).
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    test(`W-22: OrganizationSwitcher y "Cerrar menú" del drawer miden ≥44×44px a ${viewport.width}×${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/panel");

      const switcherTrigger = page.getByRole("combobox", { name: "Organización" });
      const switcherBox = await switcherTrigger.boundingBox();
      expect(switcherBox, "OrganizationSwitcher sin boundingBox").not.toBeNull();
      expect(switcherBox!.height, `OrganizationSwitcher: ${switcherBox!.height}px de alto`).toBeGreaterThanOrEqual(
        MIN_TARGET,
      );

      const userMenuButton = page.locator('button[aria-label^="Cuenta:"]');
      if (await userMenuButton.count()) {
        const userMenuBox = await userMenuButton.boundingBox();
        expect(userMenuBox, "UserMenu sin boundingBox").not.toBeNull();
        expect(userMenuBox!.width).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(userMenuBox!.height).toBeGreaterThanOrEqual(MIN_TARGET);
      }

      await page.getByRole("button", { name: "Abrir menú de navegación" }).click();
      const closeButton = page.getByRole("button", { name: "Cerrar menú" });
      const closeBox = await closeButton.boundingBox();
      expect(closeBox, '"Cerrar menú" sin boundingBox').not.toBeNull();
      expect(closeBox!.width, `"Cerrar menú": ${closeBox!.width}px de ancho`).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(closeBox!.height, `"Cerrar menú": ${closeBox!.height}px de alto`).toBeGreaterThanOrEqual(MIN_TARGET);
    });
  }
});

// W-21 (docs/auditoria-1/web-reverificacion-2.md): `OrganizationSwitcher` con
// ancho fijo empujaba a `ThemeSelector` fuera del viewport (invisible e
// intocable) en todo ancho <466px — y `html { overflow-x: clip }`
// (src/index.css) ocultaba el síntoma: `scrollWidth === clientWidth` seguía
// dando verdadero porque el contenido desbordado quedaba recortado, no
// porque cupiera. La comprobación real no es "sin scroll horizontal" sino
// que cada control interactivo del header/drawer esté DENTRO del viewport
// (boundingBox) — se comprueba a 320×568 y 390×844.
test.describe("Controles del header dentro del viewport (W-21)", () => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    test(`header: hamburguesa, OrganizationSwitcher y UserMenu quedan dentro del viewport a ${viewport.width}×${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/panel");

      const banner = page.getByRole("banner");
      const controls = [
        banner.getByRole("button", { name: "Abrir menú de navegación" }),
        banner.getByRole("combobox", { name: "Organización" }),
        banner.locator('button[aria-label^="Cuenta:"]'),
      ];

      for (const control of controls) {
        if (!(await control.count())) continue;
        const box = await control.boundingBox();
        expect(box, "control del header sin boundingBox").not.toBeNull();
        expect(box!.x, `x=${box!.x} debe ser ≥ 0`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `borde derecho (${box!.x + box!.width}) debe caber en ${viewport.width}px`).toBeLessThanOrEqual(
          viewport.width,
        );
      }

      // El selector de tema del header (visible solo desde md, ver
      // AppShell.tsx) NO debe estar en el DOM visible en estos anchos
      // móviles — vive en el drawer (ver siguiente aserción) en vez de
      // competir por el mismo espacio angosto del header.
      await expect(banner.getByRole("radiogroup", { name: "Tema de la interfaz" })).toBeHidden();

      await banner.getByRole("button", { name: "Abrir menú de navegación" }).click();
      const dialog = page.getByRole("dialog");
      const themeSelector = dialog.getByRole("radiogroup", { name: "Tema de la interfaz" });
      await expect(themeSelector).toBeVisible();
      // El Sheet desliza con `duration-500` (sheet.tsx): "visible" en el DOM
      // no significa "ya terminó de entrar" — medir a mitad de la
      // transición da un `x` negativo real (el panel todavía no llega a su
      // posición final), un falso positivo de W-21. Se espera a que la
      // animación asiente, mismo patrón que recorrido.spec.ts con
      // `transition-colors`.
      await page.waitForTimeout(550);
      const themeBox = await themeSelector.boundingBox();
      expect(themeBox, "ThemeSelector del drawer sin boundingBox").not.toBeNull();
      expect(themeBox!.x).toBeGreaterThanOrEqual(0);
      expect(themeBox!.x + themeBox!.width).toBeLessThanOrEqual(viewport.width);

      // Clicable de verdad, no solo "presente en el DOM": cambia el tema.
      await dialog.getByRole("radio", { name: "Tema oscuro" }).click();
      await expect(page.locator("html")).toHaveClass(/dark/);
    });
  }
});
