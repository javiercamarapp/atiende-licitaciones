import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";
import type { SeedData } from "./global-setup";
import { seriousOrCriticalViolations, formatViolations } from "./utils/a11y";

// ESM real ("type": "module" en package.json): sin `__dirname` global.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.resolve(__dirname, ".artifacts");

function readSeed(): SeedData {
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, "seed.json"), "utf8")) as SeedData;
}

// Mismo patrón que expediente-flujo-completo.spec.ts/dashboard.spec.ts: el
// contexto de `admin` es COMPARTIDO por todo el worker (ver fixtures.ts,
// `workers: 1` en modo "full") -- la organización activa es estado mutable
// entre archivos de spec. Se fija explícitamente a orgA en vez de asumir
// que ningún otro archivo la dejó en otra.
async function switchToOrgA(page: import("@playwright/test").Page, orgName: string) {
  await page.goto("/panel");
  const switcher = page.getByRole("combobox", { name: "Organización" });
  if (!(await switcher.innerText()).includes(orgName)) {
    await switcher.click();
    await page.getByRole("option", { name: new RegExp(orgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  }
  await expect(switcher).toContainText(orgName);
}

// Demo pública de solo lectura (ronda 7, REQ §34.4): datos de ejemplo
// servidos por MSW (mocks/browser.ts) SOLO en esta ruta, sobre un
// navegador real -- a diferencia de la suite unitaria (DemoPage.test.tsx,
// jsdom sin Service Workers), aquí el worker sí arranca de verdad.
test.describe("Demo de solo lectura (/demo)", () => {
  test("etiqueta los datos de ejemplo y muestra KPIs con datos ficticios", async ({ noAuthPage: page }) => {
    await page.goto("/demo");

    await expect(page.getByText(/Datos de ejemplo/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Panel de ejemplo" })).toBeVisible();
    await expect(page.getByText("Convocatorias nuevas (7 días)")).toBeVisible();
    await expect(page.getByText("Matches elegibles")).toBeVisible();
  });

  /**
   * R6-1 (ALTA, docs/auditoria-2/web-r7-r8a.md §5/6): la versión anterior de
   * esta prueba acumulaba en `demoApiRequests` SOLO las URLs que ya
   * contenían `/demo-api/`, y luego buscaba -- dentro de ese mismo arreglo
   * ya filtrado -- una URL que NO contuviera `/demo-api/`. Esa búsqueda es
   * imposible por construcción (un elemento no puede a la vez cumplir y no
   * cumplir el filtro con el que se lo metió al arreglo), así que la
   * prueba "nunca mezcla con datos reales" pasaba siempre, sin importar lo
   * que hiciera el código real -- una regresión que reintrodujera una
   * llamada real (p. ej. `fetch("/tenders")` en vez de
   * `fetch("/demo-api/tenders")` en `DemoPage.tsx`) jamás la habría hecho
   * fallar.
   *
   * Esta versión registra TODAS las peticiones de red (sin prefiltro) y
   * comprueba, sobre ese arreglo completo, que ninguna URL de una ruta real
   * de apps/api se disparó fuera del namespace `/demo-api/*`. Verificado
   * manualmente que SÍ puede fallar: cambiando temporalmente
   * `fetch("/demo-api/tenders")` por `fetch("/tenders")` en
   * `src/pages/DemoPage.tsx` y corriendo
   * `npx playwright test e2e/demo.spec.ts -g "nunca mezcla"` en rojo antes
   * de revertir el cambio (salida real citada en el mensaje de commit).
   */
  test("nunca mezcla con datos reales: el namespace /demo-api/* es propio", async ({ noAuthPage: page }) => {
    const allRequests: string[] = [];
    page.on("request", (req) => {
      allRequests.push(req.url());
    });
    await page.goto("/demo");
    await expect(page.getByRole("heading", { name: "Panel de ejemplo" })).toBeVisible();

    const demoApiRequests = allRequests.filter((url) => url.includes("/demo-api/"));
    expect(demoApiRequests.length).toBeGreaterThan(0);

    // Ninguna ruta real de apps/api (sin X-Org-Id, sin sesión) debió
    // dispararse desde esta pantalla -- ahora comprobado sobre TODAS las
    // peticiones observadas, no solo sobre las ya filtradas por /demo-api/.
    const realApiPaths = ["/tenders", "/matching", "/company", "/expediente", "/audit-log", "/organizations"];
    for (const p of realApiPaths) {
      const hit = allRequests.some((url) => url.includes(p) && !url.includes("/demo-api/"));
      expect(hit, `no debió llamarse a ${p} fuera de /demo-api`).toBe(false);
    }
  });

  /**
   * R6-1/R6-2 (docs/auditoria-2/web-r7-r8a.md §5/6): aislamiento real entre
   * la organización autenticada del usuario (sembrada de verdad contra
   * apps/api en global-setup.ts, nunca hardcodeada) y la demo pública.
   * `/onboarding` (autenticado, bajo `<RequireAuth/>`, ver App.tsx) trae un
   * enlace real "Ver demo" (`OnboardingPage.tsx`) -- se usa ESE enlace real
   * (`<Link>` de react-router, navegación de cliente sin recarga) para
   * entrar a /demo con una sesión real activa, en vez de fabricar el
   * escenario. Cierra dos huecos a la vez:
   *   - R6-1: la organización real del usuario autenticado (seed.orgA)
   *     NUNCA debe aparecer en /demo -- si `DemoPage`/`useAuth` alguna vez
   *     se mezclaran, esto lo detectaría.
   *   - R6-2 ("sin prueba de salir de /demo a /panel sin recargar"): se
   *     vuelve de /demo a /panel con `page.goBack()` (navegación de
   *     historial real, resuelta por react-router sin recarga completa) y
   *     se confirma que la organización real reaparece y que NINGÚN dato
   *     ficticio del demo (el nombre de la organización de ejemplo) se
   *     quedó pegado.
   */
  test.describe("Aislamiento real entre la organización autenticada y /demo (R6-1/R6-2)", () => {
    test.skip(!process.env.E2E_API_URL, "requiere `npm run test:e2e:full` (organización real sembrada en global-setup.ts)");

    test("la organización real del usuario no aparece en /demo, y /panel no hereda datos de ejemplo al volver sin recargar", async ({ page }) => {
      const seed = readSeed();

      await switchToOrgA(page, seed.orgA.name);
      await expect(page.getByText("Constructora Ejemplo")).toHaveCount(0);

      await page.goto("/onboarding");
      const allRequests: string[] = [];
      page.on("request", (req) => allRequests.push(req.url()));

      // Navegación de CLIENTE real (react-router <Link>), no `page.goto`:
      // ejercita el mismo camino que un usuario real seguiría, sin recarga
      // completa del documento.
      await page.getByRole("link", { name: "Ver demo" }).click();
      await expect(page).toHaveURL(/\/demo$/);
      await expect(page.getByRole("heading", { name: "Panel de ejemplo" })).toBeVisible();

      // Aislamiento real: la organización autenticada (orgA, sembrada de
      // verdad) no debe aparecer en la demo pública, ni siquiera con la
      // sesión real todavía activa en el mismo navegador.
      await expect(page.getByText(seed.orgA.name)).toHaveCount(0);
      await expect(page.getByText("Constructora Ejemplo")).toBeVisible();
      const leaked = allRequests.some((url) => (url.includes("/tenders") || url.includes("/matching") || url.includes("/organizations")) && !url.includes("/demo-api/"));
      expect(leaked, "la sesión real no debió llamar a ninguna ruta real de apps/api mientras /demo está montada").toBe(false);

      // R6-2 ("sin prueba de salir de /demo a /panel sin recargar"): se
      // sale de /demo con el historial del navegador (`goBack`), que
      // react-router resuelve como navegación de CLIENTE (sin recarga
      // completa del documento) porque la entrada anterior (/onboarding)
      // fue empujada por el mismo `<Link>` de arriba. Los datos de ejemplo
      // no deben quedarse pegados en la pantalla real siguiente.
      await page.goBack();
      await expect(page).toHaveURL(/\/onboarding$/);
      await expect(page.getByText("Constructora Ejemplo")).toHaveCount(0);

      // Una segunda entrada más atrás en el historial llega a /panel (la
      // navegación original a /onboarding sí fue una carga completa, ver
      // arriba) -- se confirma que la organización real sigue siendo la
      // que se muestra, sin ningún residuo del mock de /demo.
      await page.goBack();
      await expect(page).toHaveURL(/\/panel$/);
      // `getByText(seed.orgA.name)` a secas es ambiguo aquí (el nombre
      // también aparece en la descripción "Resumen en tiempo real de..."
      // de PanelPage.tsx) -- se acota al combobox real, mismo patrón que
      // `switchToOrgA`/`switchOrganization` en el resto de la suite.
      await expect(page.getByRole("combobox", { name: "Organización" })).toContainText(seed.orgA.name);
      await expect(page.getByText("Constructora Ejemplo")).toHaveCount(0);
    });
  });

  test("enlaza de vuelta a inicio y a iniciar sesión", async ({ noAuthPage: page }) => {
    await page.goto("/demo");
    await expect(page.getByRole("heading", { name: "Panel de ejemplo" })).toBeVisible();
    await page.getByRole("link", { name: /Iniciar sesión/ }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("sin violaciones serious/critical de axe", async ({ noAuthPage: page }) => {
    await page.goto("/demo");
    await expect(page.getByRole("heading", { name: "Panel de ejemplo" })).toBeVisible();
    const violations = await seriousOrCriticalViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  test("móvil 390×844: sin scroll horizontal", async ({ noAuthPage: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/demo");
    await expect(page.getByText(/Datos de ejemplo/)).toBeVisible();
    const scroll = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(scroll.scrollWidth).toBe(scroll.clientWidth);
  });
});
