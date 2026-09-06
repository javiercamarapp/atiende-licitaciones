// Script de captura para la auditoría adversarial de apps/web (Atiende Licitaciones).
// Uso: node docs/auditoria-1/capturas/capturar.mjs
// Requiere: servidor `npm run -w apps/web preview -- --port 4173 --strictPort` corriendo,
// y `npx playwright install chromium` ya ejecutado.
//
// Genera capturas PNG en docs/auditoria-1/capturas/ y un reporte axe-core (JSON + resumen
// de texto) por página en docs/auditoria-1/capturas/axe-*.json.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:4173";
const AXE_SOURCE = fs.readFileSync(
  path.join(__dirname, "../../../node_modules/axe-core/axe.min.js"),
  "utf-8",
);

async function runAxe(page, name) {
  await page.evaluate(AXE_SOURCE);
  const results = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    return await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] },
    });
  });
  fs.writeFileSync(
    path.join(__dirname, `axe-${name}.json`),
    JSON.stringify(
      {
        url: results.url,
        violations: results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          help: v.help,
          nodes: v.nodes.map((n) => ({ target: n.target, html: n.html, failureSummary: n.failureSummary })),
        })),
        passes: results.passes.length,
        incomplete: results.incomplete.map((v) => ({ id: v.id, impact: v.impact })),
      },
      null,
      2,
    ),
  );
  const critSer = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  console.log(
    `axe[${name}]: violations=${results.violations.length} (critical/serious=${critSer.length}) passes=${results.passes.length} incomplete=${results.incomplete.length}`,
  );
  if (results.violations.length) {
    for (const v of results.violations) {
      console.log(`  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodos)`);
    }
  }
  return results;
}

async function main() {
  const browser = await chromium.launch();

  // ---- Desktop, tema claro ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    const page = await ctx.newPage();

    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(__dirname, "01-login.png") });
    await runAxe(page, "login");

    // Foco por teclado: tab hasta el skip-link, luego Enter
    await page.keyboard.press("Tab");
    await page.screenshot({ path: path.join(__dirname, "01b-login-skiplink-focus.png") });

    await page.goto(`${BASE}/panel`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(__dirname, "02-panel.png") });
    await runAxe(page, "panel");

    await page.goto(`${BASE}/convocatorias/fuentes-frescura`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(__dirname, "03-fuentes-frescura.png") });
    await runAxe(page, "fuentes-frescura");

    await page.goto(`${BASE}/entrega/paquete-descargable`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(__dirname, "04-paquete-descargable.png") });
    await runAxe(page, "paquete-descargable");

    await page.goto(`${BASE}/convocatorias/descubrimiento`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(__dirname, "05-modulo-empty-state.png") });
    await runAxe(page, "modulo-empty-state");

    // Navegación por teclado dentro del panel: tab hasta el botón de menú/hamburguesa
    // no aplica en desktop (oculto), probamos foco visible en nav lateral
    await page.goto(`${BASE}/panel`, { waitUntil: "networkidle" });
    for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
    await page.screenshot({ path: path.join(__dirname, "06-panel-focus-visible.png") });

    await ctx.close();
  }

  // ---- Desktop, tema oscuro ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/panel`, { waitUntil: "networkidle" });
    // Interactuar con el ThemeSelector real (clic en "Tema oscuro"), no simular
    // vía localStorage con una clave adivinada — la clave real es
    // "atiende-licitaciones-tema" (src/components/ThemeSelector.tsx).
    await page.getByRole("radio", { name: "Tema oscuro" }).click();
    await page.waitForTimeout(150);
    const htmlHasDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    console.log(`theme: <html> tiene clase .dark tras clic en "Tema oscuro" = ${htmlHasDark}`);
    await page.screenshot({ path: path.join(__dirname, "07-panel-dark.png") });
    await runAxe(page, "panel-dark");

    // Persistencia: recargar y confirmar que el tema oscuro se mantiene (localStorage)
    await page.reload({ waitUntil: "networkidle" });
    const htmlHasDarkAfterReload = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    console.log(`theme: <html> tiene clase .dark tras recargar = ${htmlHasDarkAfterReload}`);
    await ctx.close();
  }

  // ---- Móvil 390x844 ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    const page = await ctx.newPage();

    await page.goto(`${BASE}/panel`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(__dirname, "08-mobile-panel-closed.png"), fullPage: true });

    // Medir si hay scroll horizontal
    const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    console.log(`mobile[panel]: scrollWidth>clientWidth (scroll horizontal) = ${hasHScroll}`);

    // Tamaño de targets ANTES de abrir el drawer: una vez abierto, Radix Dialog
    // marca el resto de la página aria-hidden (comportamiento correcto de foco
    // atrapado), y el propio botón que abrió el drawer deja de ser localizable
    // por rol/nombre accesible mientras el diálogo está abierto.
    const menuButton = page.getByRole("button", { name: "Abrir menú de navegación" });
    const btnBox = await menuButton.boundingBox();
    console.log(`mobile[panel]: boton hamburguesa boundingBox (antes de abrir) = ${JSON.stringify(btnBox)}`);

    // Abrir drawer móvil
    await menuButton.click();
    await page.waitForTimeout(350); // animación del Sheet
    await page.screenshot({ path: path.join(__dirname, "09-mobile-drawer-open.png") });
    await runAxe(page, "mobile-drawer-open");

    // Confirma que Radix deja el fondo inerte (aria-hidden) mientras el drawer está abierto
    const backgroundInert = await page.evaluate(() => {
      const aside = document.querySelector("aside");
      return aside ? aside.closest("[aria-hidden='true']") !== null || aside.getAttribute("aria-hidden") === "true" : null;
    });
    console.log(`mobile[panel]: fondo marcado aria-hidden mientras el drawer está abierto = ${backgroundInert}`);

    // Tamaño de targets dentro del drawer abierto (primer link de navegación).
    // Ojo: hay dos <nav aria-label="Navegación principal"> en el DOM (sidebar
    // desktop oculta + drawer móvil abierto) — acotar al diálogo abierto.
    const firstNavLink = page.locator('[role="dialog"] nav[aria-label="Navegación principal"] a').first();
    const linkBox = await firstNavLink.boundingBox();
    console.log(`mobile[panel]: primer link de nav dentro del drawer boundingBox = ${JSON.stringify(linkBox)}`);

    // Cerrar con Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(__dirname, "10-mobile-drawer-escape-closed.png") });
    const drawerVisibleAfterEscape = await page.evaluate(() => {
      const el = document.querySelector('[role="dialog"]');
      return el ? getComputedStyle(el).display !== "none" && el.getClientRects().length > 0 : false;
    });
    console.log(`mobile[panel]: drawer sigue visible tras Escape = ${drawerVisibleAfterEscape}`);

    await ctx.close();
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
