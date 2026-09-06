import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";

// W-08: LoginPage es la única pantalla que no usa <AppShell/> y no tenía
// landmark <main> ni <h1> propio — axe reportaba landmark-one-main,
// page-has-heading-one y region (las tres moderate). Verificado sobre el
// documento real servido por `vite preview` (no jsdom, ver W-13).
//
// Ronda 3 (W-12): con sesión (fixture `page` por defecto, autenticada como
// `admin` — ver e2e/fixtures.ts), visitar /login redirige a /panel
// (LoginPage.tsx). Esta prueba necesita el formulario real, así que usa
// `noAuthPage` (un contexto sin ninguna sesión).
test("/login tiene landmark <main>, un <h1> real y ningún contenido fuera de landmarks (W-08)", async ({ noAuthPage: page }) => {
  await page.goto("/login");
  const results = await new AxeBuilder({ page })
    .withRules(["landmark-one-main", "page-has-heading-one", "region"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});
