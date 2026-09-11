import { describe, expect, it } from "vitest";
import { formatGateReport, runEvalSuite } from "../src/runner.js";
import type { CategoryThreshold, EvalCategory, GraderVerdict } from "../src/types.js";

function verdict(category: EvalCategory, overrides: Partial<GraderVerdict> = {}): GraderVerdict {
  return { caseId: "c1", category, pass: true, reason: "ok", ...overrides };
}

describe("runEvalSuite (mecanismo del gate, independiente de la lógica de negocio real)", () => {
  it("overallStatus 'pass' cuando todas las categorías cumplen su umbral", () => {
    const thresholds: CategoryThreshold[] = [
      { category: "no_fabricacion", minPassRate: 1, zeroTolerance: true, calibratedAgainstRealGoldSet: false },
    ];
    const report = runEvalSuite([verdict("no_fabricacion", { pass: true }), verdict("no_fabricacion", { pass: true })], thresholds);
    expect(report.overallStatus).toBe("pass");
    expect(report.categories[0].status).toBe("ok");
    expect(report.totalCases).toBe(2);
    expect(report.totalPassed).toBe(2);
  });

  it("overallStatus 'fail' cuando una categoría de tolerancia cero tiene UN solo fallo, aunque el passRate agregado sea alto", () => {
    const thresholds: CategoryThreshold[] = [
      { category: "no_fabricacion", minPassRate: 0.9, zeroTolerance: true, calibratedAgainstRealGoldSet: false },
    ];
    const verdicts = [
      ...Array.from({ length: 19 }, () => verdict("no_fabricacion", { pass: true })),
      verdict("no_fabricacion", { pass: false, reason: "REGRESIÓN: se filtró un valor sin fuente" }),
    ];
    const report = runEvalSuite(verdicts, thresholds);
    // 19/20 = 95% >= 90% (pasaría un umbral de tasa simple), pero
    // zeroTolerance=true rompe el build igual: esto es lo que prueba que el
    // gate NO es un promedio permisivo para categorías de cumplimiento legal.
    expect(report.categories[0].passRate).toBeCloseTo(0.95);
    expect(report.categories[0].status).toBe("below_threshold");
    expect(report.overallStatus).toBe("fail");
  });

  it("overallStatus 'fail' cuando el passRate cae bajo minPassRate en una categoría SIN tolerancia cero", () => {
    const thresholds: CategoryThreshold[] = [
      { category: "juicio_calidad_redaccion", minPassRate: 0.8, zeroTolerance: false, calibratedAgainstRealGoldSet: false },
    ];
    const verdicts = [
      verdict("juicio_calidad_redaccion", { pass: true }),
      verdict("juicio_calidad_redaccion", { pass: false }),
      verdict("juicio_calidad_redaccion", { pass: false }),
      verdict("juicio_calidad_redaccion", { pass: true }),
    ];
    const report = runEvalSuite(verdicts, thresholds);
    expect(report.categories[0].passRate).toBe(0.5);
    expect(report.categories[0].status).toBe("below_threshold");
    expect(report.overallStatus).toBe("fail");
  });

  it("una categoría SIN tolerancia cero SÍ tolera fallos aislados por debajo del umbral configurado", () => {
    const thresholds: CategoryThreshold[] = [
      { category: "juicio_calidad_redaccion", minPassRate: 0.5, zeroTolerance: false, calibratedAgainstRealGoldSet: false },
    ];
    const verdicts = [
      verdict("juicio_calidad_redaccion", { pass: true }),
      verdict("juicio_calidad_redaccion", { pass: false }),
      verdict("juicio_calidad_redaccion", { pass: true }),
      verdict("juicio_calidad_redaccion", { pass: true }),
    ];
    const report = runEvalSuite(verdicts, thresholds);
    expect(report.categories[0].passRate).toBe(0.75);
    expect(report.categories[0].status).toBe("ok");
    expect(report.overallStatus).toBe("pass");
  });

  it("una categoría sin ningún caso (total=0) nunca rompe el build por sí sola (no hay 0/0 == fail)", () => {
    const thresholds: CategoryThreshold[] = [
      { category: "inyeccion_prompt", minPassRate: 1, zeroTolerance: true, calibratedAgainstRealGoldSet: false },
    ];
    const report = runEvalSuite([], thresholds);
    expect(report.categories[0].status).toBe("ok");
    expect(report.overallStatus).toBe("pass");
  });

  it("agrega correctamente varias categorías con fallos en solo una de ellas", () => {
    const thresholds: CategoryThreshold[] = [
      { category: "anticorrupcion_anticolusion", minPassRate: 1, zeroTolerance: true, calibratedAgainstRealGoldSet: false },
      { category: "autorizacion_rol", minPassRate: 1, zeroTolerance: true, calibratedAgainstRealGoldSet: false },
    ];
    const verdicts = [
      verdict("anticorrupcion_anticolusion", { pass: true }),
      verdict("autorizacion_rol", { pass: false, reason: "REGRESIÓN de autorización" }),
    ];
    const report = runEvalSuite(verdicts, thresholds);
    expect(report.categories.find((c) => c.category === "anticorrupcion_anticolusion")?.status).toBe("ok");
    expect(report.categories.find((c) => c.category === "autorizacion_rol")?.status).toBe("below_threshold");
    expect(report.overallStatus).toBe("fail");
  });
});

describe("formatGateReport", () => {
  it("incluye el estado general, cada categoría y el detalle de cada fallo", () => {
    const thresholds: CategoryThreshold[] = [
      { category: "no_fabricacion", minPassRate: 1, zeroTolerance: true, calibratedAgainstRealGoldSet: false },
    ];
    const report = runEvalSuite([verdict("no_fabricacion", { pass: false, caseId: "nf-99", reason: "motivo real del fallo" })], thresholds);
    const text = formatGateReport(report);
    expect(text).toContain("FAIL");
    expect(text).toContain("nf-99");
    expect(text).toContain("motivo real del fallo");
  });

  it("marca explícitamente las categorías NO calibradas contra un gold set humano real", () => {
    const thresholds: CategoryThreshold[] = [
      { category: "juicio_calidad_redaccion", minPassRate: 0.8, zeroTolerance: false, calibratedAgainstRealGoldSet: false },
    ];
    const report = runEvalSuite([verdict("juicio_calidad_redaccion", { pass: true })], thresholds);
    const text = formatGateReport(report);
    expect(text).toContain("NO calibrado contra gold set humano real");
  });
});
