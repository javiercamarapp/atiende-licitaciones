import { describe, expect, it } from "vitest";
import { GATE_THRESHOLDS } from "../src/thresholds.js";
import { EVAL_CATEGORIES } from "../src/types.js";
import {
  ANTICORRUPTION_CASES,
  AUTHORIZATION_CASES,
  JUDGE_CASES,
  NO_FABRICATION_CASES,
  PROMPT_INJECTION_CASES,
} from "../src/cases/index.js";

describe("GATE_THRESHOLDS cubre EXACTAMENTE cada EvalCategory declarada (sin huecos, sin duplicados)", () => {
  it("tiene un umbral por cada categoría de EVAL_CATEGORIES, una sola vez", () => {
    const thresholdCategories = GATE_THRESHOLDS.map((t) => t.category).sort();
    expect(thresholdCategories).toEqual([...EVAL_CATEGORIES].sort());
    expect(new Set(thresholdCategories).size).toBe(thresholdCategories.length);
  });

  it("las categorías de cumplimiento legal (anticorrupción/inyección/no-fabricación/autorización) exigen tolerancia cero", () => {
    const legalCategories = ["anticorrupcion_anticolusion", "inyeccion_prompt", "no_fabricacion", "autorizacion_rol"] as const;
    for (const category of legalCategories) {
      const threshold = GATE_THRESHOLDS.find((t) => t.category === category)!;
      expect(threshold.zeroTolerance, `${category} debería exigir tolerancia cero`).toBe(true);
      expect(threshold.minPassRate).toBe(1);
    }
  });

  it("ninguna categoría se presenta como calibrada contra el gold set humano real (REQ-021 sigue bloqueado)", () => {
    for (const threshold of GATE_THRESHOLDS) {
      expect(threshold.calibratedAgainstRealGoldSet, `${threshold.category} no debería declararse calibrada`).toBe(false);
    }
  });
});

describe("todos los casos fixture usan una EvalCategory válida (EVAL_CATEGORIES)", () => {
  const allCases = [...ANTICORRUPTION_CASES, ...PROMPT_INJECTION_CASES, ...NO_FABRICATION_CASES, ...AUTHORIZATION_CASES, ...JUDGE_CASES];

  it(`hay al menos un caso (${allCases.length} en total) y todos declaran una categoría de EVAL_CATEGORIES`, () => {
    expect(allCases.length).toBeGreaterThan(0);
    for (const evalCase of allCases) {
      expect(EVAL_CATEGORIES).toContain(evalCase.category);
    }
  });

  it("todos los ids de caso son únicos (un id duplicado silenciaría un caso en el reporte agregado)", () => {
    const ids = allCases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
