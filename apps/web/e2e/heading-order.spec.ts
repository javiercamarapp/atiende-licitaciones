import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

// W-07: `CardTitle` estaba fijo a <h3> sin forma de configurarlo — cualquier
// página con `SectionHeader` (h1) + `Card` saltaba de h1 a h3 sin pasar por
// h2 (violación axe "moderate" heading-order). Verificado sobre el documento
// real (no jsdom, ver W-13).
const RUTAS_CON_CARD_TITLE = ["/convocatorias/fuentes-frescura", "/entrega/paquete-descargable"];

test.describe("Orden de encabezados (W-07)", () => {
  for (const ruta of RUTAS_CON_CARD_TITLE) {
    test(`${ruta} no tiene salto de nivel de encabezado`, async ({ page }) => {
      await page.goto(ruta);
      const results = await new AxeBuilder({ page }).withRules(["heading-order"]).analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });
  }
});
