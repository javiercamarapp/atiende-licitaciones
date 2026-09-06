import { test, expect } from "@playwright/test";

import { formatViolations, seriousOrCriticalViolations } from "./utils/a11y";

// W-05 / W-06: axe-core inyectado sobre el documento real servido por
// `vite preview` (no jsdom) — REQ-089 exige "sin hallazgos critical/serious".
test.describe("Contraste de color (W-05, W-06)", () => {
  test("el wordmark en modo oscuro no tiene violaciones serias de contraste", async ({ page }) => {
    await page.goto("/panel");
    await page.getByRole("radio", { name: "Tema oscuro" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    // `transition-colors` anima el color del link activo del sidebar
    // (~200ms); sin esta espera axe puede muestrear un color intermedio de
    // la transición y reportar un falso "serious" transitorio que no existe
    // una vez asentado el tema.
    await page.waitForTimeout(300);

    const violations = await seriousOrCriticalViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  test("los badges de estado de fuente (CAPTCHA / cambio de interfaz) no tienen violaciones serias de contraste", async ({
    page,
  }) => {
    await page.goto("/convocatorias/fuentes-frescura");

    const violations = await seriousOrCriticalViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});
