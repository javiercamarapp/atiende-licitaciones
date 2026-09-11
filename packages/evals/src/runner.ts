import type { CategoryResult, CategoryThreshold, EvalCategory, GateReport, GraderVerdict } from "./types.js";

export interface RunEvalSuiteOptions {
  /** Reloj inyectable para pruebas deterministas del propio runner. */
  now?: () => Date;
}

/**
 * Corre TODOS los veredictos ya calculados (ver `cli.ts` para cómo se
 * arman a partir de los graders reales) y produce el reporte agregado por
 * categoría contra `thresholds`. Puro: no ejecuta graders, no sabe nada de
 * `@atiende/agents` -- solo agrega y aplica el umbral. Esto es lo que hace
 * testeable el MECANISMO del gate (¿un umbral roto realmente produce
 * `overallStatus: "fail"`?) sin depender de la lógica de negocio real en
 * las pruebas de este archivo (esa parte la cubren `graders/*` y las
 * pruebas de integración de `apps/worker`).
 */
export function runEvalSuite(verdicts: GraderVerdict[], thresholds: readonly CategoryThreshold[], options: RunEvalSuiteOptions = {}): GateReport {
  const now = options.now ?? (() => new Date());
  const byCategory = new Map<EvalCategory, GraderVerdict[]>();
  for (const verdict of verdicts) {
    const list = byCategory.get(verdict.category) ?? [];
    list.push(verdict);
    byCategory.set(verdict.category, list);
  }

  const categories: CategoryResult[] = thresholds.map((threshold) => {
    const categoryVerdicts = byCategory.get(threshold.category) ?? [];
    const total = categoryVerdicts.length;
    const passed = categoryVerdicts.filter((v) => v.pass).length;
    const passRate = total === 0 ? 1 : passed / total;
    const failures = categoryVerdicts.filter((v) => !v.pass);
    const belowThreshold = threshold.zeroTolerance ? failures.length > 0 : passRate < threshold.minPassRate;
    return {
      category: threshold.category,
      total,
      passed,
      passRate,
      threshold,
      status: belowThreshold ? "below_threshold" : "ok",
      failures,
    };
  });

  const totalCases = categories.reduce((sum, c) => sum + c.total, 0);
  const totalPassed = categories.reduce((sum, c) => sum + c.passed, 0);
  const overallStatus: GateReport["overallStatus"] = categories.some((c) => c.status === "below_threshold") ? "fail" : "pass";

  return {
    generatedAt: now().toISOString(),
    overallStatus,
    categories,
    totalCases,
    totalPassed,
  };
}

/** Formatea el reporte para consola/logs de CI (legible por humanos, sin depender de que se parsee el JSON). */
export function formatGateReport(report: GateReport): string {
  const lines: string[] = [];
  lines.push(`Gate de evals -- generado ${report.generatedAt}`);
  lines.push(`Estado general: ${report.overallStatus.toUpperCase()} (${report.totalPassed}/${report.totalCases} casos)`);
  lines.push("");
  for (const category of report.categories) {
    const calibrationNote = category.threshold.calibratedAgainstRealGoldSet
      ? ""
      : " [NO calibrado contra gold set humano real -- ver docs/ACEPTACION.md REQ-021]";
    lines.push(
      `- ${category.category}: ${category.passed}/${category.total} (${(category.passRate * 100).toFixed(1)}%) ` +
        `umbral=${(category.threshold.minPassRate * 100).toFixed(0)}%${category.threshold.zeroTolerance ? " (tolerancia cero)" : ""} ` +
        `-> ${category.status.toUpperCase()}${calibrationNote}`,
    );
    for (const failure of category.failures) {
      lines.push(`    FALLO [${failure.caseId}]: ${failure.reason}`);
    }
  }
  return lines.join("\n");
}
