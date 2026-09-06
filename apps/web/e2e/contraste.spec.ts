import { test, expect } from "./fixtures";

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

  // W-17: el badge `destructive` ("Caída", "Permisos faltantes") nunca se
  // auditó en modo OSCURO real — la ronda de corrección de W-06 solo probó
  // el badge `warning` (CAPTCHA/Cambio de interfaz) en claro. axe-core dio
  // una violación "serious" de color-contrast (4.30:1 < 4.5:1) hasta que se
  // ajustó `--destructive` en `.dark` (ver src/index.css,
  // src/lib/contrast.test.ts).
  test("los 5 estados de fuente (incluido el badge destructive) no tienen violaciones serias de contraste en modo oscuro", async ({
    page,
  }) => {
    await page.goto("/convocatorias/fuentes-frescura");
    await page.getByRole("radio", { name: "Tema oscuro" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.waitForTimeout(300);

    for (const label of ["OK", "Caída", "CAPTCHA", "Cambio de interfaz", "Permisos faltantes"]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    const violations = await seriousOrCriticalViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});
