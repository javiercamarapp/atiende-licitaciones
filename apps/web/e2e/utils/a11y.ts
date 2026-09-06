import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * REQ-089 exige "sin hallazgos critical/serious", no "cero violaciones de
 * cualquier impacto" — moderate/minor se registran pero no bloquean la
 * suite. Se corre sobre `document` completo (el árbol real que sirve
 * `vite preview`), a diferencia de las pruebas vitest-axe que solo cubren el
 * subárbol montado por Testing Library (ver W-13).
 */
export async function seriousOrCriticalViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
}

export function formatViolations(violations: Awaited<ReturnType<typeof seriousOrCriticalViolations>>): string {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} nodo(s): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
    .join("\n");
}
