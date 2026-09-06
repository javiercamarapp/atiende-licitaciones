import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";

// W-08: LoginPage es la única pantalla que no usa <AppShell/> y no tenía
// landmark <main> ni <h1> propio — axe reportaba landmark-one-main,
// page-has-heading-one y region (las tres moderate). Verificado sobre el
// documento real servido por `vite preview` (no jsdom, ver W-13).
test("/login tiene landmark <main>, un <h1> real y ningún contenido fuera de landmarks (W-08)", async ({ page }) => {
  await page.goto("/login");
  const results = await new AxeBuilder({ page })
    .withRules(["landmark-one-main", "page-has-heading-one", "region"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});
