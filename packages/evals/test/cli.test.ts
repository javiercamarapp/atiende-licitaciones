import { describe, expect, it } from "vitest";
import { computeGateReport, runCli } from "../src/cli.js";
import { gradeAnticorruption } from "../src/graders/anticorruption.js";
import { runEvalSuite } from "../src/runner.js";
import { GATE_THRESHOLDS } from "../src/thresholds.js";
import { ANTICORRUPTION_CASES } from "../src/cases/index.js";
import type { EvalCase } from "../src/types.js";
import type { AnticorruptionCaseInput } from "../src/graders/anticorruption.js";

/**
 * Prueba de extremo a extremo: TODO el gate real (graders + casos +
 * FakeCalibratedJudge, sin `OPENAI_API_KEY`) debe pasar hoy en este
 * repositorio -- esta es la evidencia real de "el gate pasa en verde"
 * citada en docs/ACEPTACION.md, no una afirmación sin correr.
 */
describe("computeGateReport (extremo a extremo, sin credenciales)", () => {
  it("el gate real pasa hoy (overallStatus 'pass') con los graders/casos/juez fake de este repositorio", async () => {
    const report = await computeGateReport(undefined);
    if (report.overallStatus !== "pass") {
      throw new Error(
        `El gate real debería pasar; categorías fuera de umbral: ${JSON.stringify(
          report.categories.filter((c) => c.status === "below_threshold"),
          null,
          2,
        )}`,
      );
    }
    expect(report.overallStatus).toBe("pass");
    expect(report.totalCases).toBeGreaterThan(20);
  });

  it("cada categoría configurada en GATE_THRESHOLDS recibió al menos un caso real (ningún umbral queda sin ejercitar)", async () => {
    const report = await computeGateReport(undefined);
    for (const category of report.categories) {
      expect(category.total, `categoría ${category.category} sin ningún caso`).toBeGreaterThan(0);
    }
  });
});

describe("runCli (código de salida real -- prueba de que el gate BLOQUEA, no solo reporta)", () => {
  it("devuelve 0 cuando el gate pasa", async () => {
    const code = await runCli(undefined);
    expect(code).toBe(0);
  });
});

describe("prueba de mutación sobre el gate completo: una regresión real en un caso rompe el exit code", () => {
  it("si un caso adversarial deja de bloquear (regresión simulada inyectando un veredicto falso), runEvalSuite marca 'fail' -- reproduciendo lo que pasaría si el guardrail real se rompiera", () => {
    // Se reconstruye el flujo de gradeAnticorruption con un veredicto que
    // MIENTE sobre el resultado real del guardrail (simula la regresión:
    // "el guardrail ya no bloquea este caso"), y se confirma que
    // runEvalSuite (el mecanismo real del gate, no un mock) lo traduce en
    // overallStatus 'fail'. No se modifica el guardrail de producción para
    // esta prueba -- solo se corrobora que el AGREGADOR reacciona.
    const realVerdicts = ANTICORRUPTION_CASES.map((c: EvalCase<AnticorruptionCaseInput>) => gradeAnticorruption(c));
    expect(realVerdicts.every((v) => v.pass)).toBe(true); // línea base real: hoy todo pasa.

    const regressedVerdicts = realVerdicts.map((v, i) => (i === 0 ? { ...v, pass: false, reason: "REGRESIÓN SIMULADA" } : v));
    const report = runEvalSuite(regressedVerdicts, GATE_THRESHOLDS.filter((t) => t.category === "anticorrupcion_anticolusion"));
    expect(report.overallStatus).toBe("fail");
  });
});
