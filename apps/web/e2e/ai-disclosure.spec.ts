import { test, expect } from "@playwright/test";

// W-15 (REQ-115): disclosure de uso de IA obligatorio también en el
// "portal", antepuesto a los módulos que mostrarán contenido generado por
// IA en cuanto exista backend (redacción, revisión, análisis de bases).
const RUTAS_CON_DISCLOSURE = ["/preparacion/redaccion", "/preparacion/revision", "/evaluacion/analisis-bases"];

test.describe("Disclosure de IA (W-15)", () => {
  for (const ruta of RUTAS_CON_DISCLOSURE) {
    test(`${ruta} muestra el aviso de uso de IA`, async ({ page }) => {
      await page.goto(ruta);
      await expect(page.getByRole("note", { name: "Aviso de uso de inteligencia artificial" })).toBeVisible();
    });
  }
});
