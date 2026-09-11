import { describe, expect, it } from "vitest";
import * as evals from "../src/index.js";

/** Smoke test del barrel público: confirma que el paquete expone su API real (no solo que compila). */
describe("barrel público (src/index.ts)", () => {
  it("re-exporta el runner, los umbrales, los graders y los casos reales", () => {
    expect(typeof evals.runEvalSuite).toBe("function");
    expect(typeof evals.formatGateReport).toBe("function");
    expect(evals.GATE_THRESHOLDS.length).toBeGreaterThan(0);
    expect(typeof evals.gradeAnticorruption).toBe("function");
    expect(typeof evals.gradeNoFabrication).toBe("function");
    expect(typeof evals.gradeAuthorization).toBe("function");
    expect(typeof evals.buildJudge).toBe("function");
    expect(evals.ANTICORRUPTION_CASES.length).toBeGreaterThan(0);
    expect(typeof evals.computeGateReport).toBe("function");
    expect(typeof evals.runCli).toBe("function");
  });
});
