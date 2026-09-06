import { test as base, expect, type Page } from "@playwright/test";

/**
 * App.tsx carga cada página con React.lazy()/Suspense: el evento "load" del
 * navegador (el que espera `page.goto()` por defecto) dispara en cuanto se
 * ejecuta el bundle de entrada, no cuando termina de llegar el chunk de la
 * ruta — mientras tanto el DOM real es la `LoadingScreen` (un `role="status"`
 * sin landmarks ni encabezados). Sin esperar a que la red esté quieta, una
 * aserción de axe o de foco que corre justo después de `goto()` puede
 * terminar auditando la pantalla de carga en vez de la página real, dando
 * "violaciones" o fallos de foco que no existen (falsos positivos
 * intermitentes, más frecuentes cuantos más workers compiten por CPU/red).
 *
 * Este fixture envuelve `page.goto()` para esperar siempre a `networkidle`
 * antes de devolver el control — todas las specs deben importar `test`
 * desde aquí en vez de `@playwright/test` directamente.
 */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    const originalGoto = page.goto.bind(page);
    page.goto = (async (url: string, options?: Parameters<Page["goto"]>[1]) => {
      const response = await originalGoto(url, options);
      await page.waitForLoadState("networkidle");
      return response;
    }) as Page["goto"];
    await use(page);
  },
});

export { expect };
