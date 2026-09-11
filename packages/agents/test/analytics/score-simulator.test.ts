import { describe, expect, it } from "vitest";
import {
  runScoreSimulatorBenchmark,
  SCORE_SIMULATOR_ACCURACY_THRESHOLD,
  simulateTechnicalScore,
  validateRubric,
  type ScoringRubric,
} from "../../src/analytics/score-simulator.js";
import { SYNTHETIC_SCORE_GOLDMATRIX } from "./fixtures/synthetic-score-goldmatrix.js";

const RUBRIC_50: ScoringRubric = {
  technicalSections: [
    { key: "experiencia", label: "Experiencia", maxPoints: 20 },
    { key: "metodologia", label: "Metodología", maxPoints: 15 },
    { key: "equipo", label: "Equipo", maxPoints: 15 },
  ],
  technicalTotalPoints: 50,
  economicMaxPoints: 50,
  minimumTechnicalPoints: 37.5,
};

describe("validateRubric (REQ-020: la suma de rubros siempre es 50 o 60)", () => {
  it("una rúbrica bien formada de 50 puntos no reporta problemas", () => {
    expect(validateRubric(RUBRIC_50)).toEqual([]);
  });

  it("una rúbrica bien formada de 60 puntos tampoco reporta problemas", () => {
    const rubric60: ScoringRubric = {
      technicalSections: [
        { key: "a", label: "A", maxPoints: 30 },
        { key: "b", label: "B", maxPoints: 30 },
      ],
      technicalTotalPoints: 60,
      economicMaxPoints: 40,
    };
    expect(validateRubric(rubric60)).toEqual([]);
  });

  it("detecta cuando la suma de rubros no coincide con el total declarado", () => {
    const broken: ScoringRubric = { ...RUBRIC_50, technicalSections: [{ key: "a", label: "A", maxPoints: 30 }] };
    const issues = validateRubric(broken);
    expect(issues.map((i) => i.code)).toContain("SECTION_SUM_MISMATCH");
  });

  it("detecta un total técnico distinto de 50 o 60 (p. ej. 55)", () => {
    const broken: ScoringRubric = {
      technicalSections: [{ key: "a", label: "A", maxPoints: 55 }],
      technicalTotalPoints: 55 as unknown as 50, // simula un dato mal capturado que burla el tipo
      economicMaxPoints: 45,
    };
    const issues = validateRubric(broken);
    expect(issues.map((i) => i.code)).toContain("INVALID_TOTAL");
  });

  it("detecta cuando técnica + económica no suma 100", () => {
    const broken: ScoringRubric = { ...RUBRIC_50, economicMaxPoints: 40 };
    const issues = validateRubric(broken);
    expect(issues.map((i) => i.code)).toContain("TOTAL_NOT_100");
  });

  it("detecta un rubro con maxPoints <= 0", () => {
    const broken: ScoringRubric = {
      technicalSections: [
        { key: "a", label: "A", maxPoints: 50 },
        { key: "b", label: "B", maxPoints: 0 },
      ],
      technicalTotalPoints: 50,
      economicMaxPoints: 50,
    };
    expect(validateRubric(broken).map((i) => i.code)).toContain("NON_POSITIVE_SECTION");
  });

  it("detecta keys de rubro duplicadas", () => {
    const broken: ScoringRubric = {
      technicalSections: [
        { key: "a", label: "A", maxPoints: 25 },
        { key: "a", label: "A duplicada", maxPoints: 25 },
      ],
      technicalTotalPoints: 50,
      economicMaxPoints: 50,
    };
    expect(validateRubric(broken).map((i) => i.code)).toContain("DUPLICATE_SECTION_KEY");
  });

  it("detecta una rúbrica sin ningún rubro", () => {
    const broken: ScoringRubric = { technicalSections: [], technicalTotalPoints: 50, economicMaxPoints: 50 };
    expect(validateRubric(broken).map((i) => i.code)).toEqual(expect.arrayContaining(["NO_SECTIONS", "SECTION_SUM_MISMATCH"]));
  });
});

describe("simulateTechnicalScore", () => {
  it("cumplimiento total con evidencia citada suma el total exacto", () => {
    const result = simulateTechnicalScore(RUBRIC_50, [
      { sectionKey: "experiencia", achievedPoints: 20, hasEvidenceReference: true, evidenceRefs: ["doc-1"] },
      { sectionKey: "metodologia", achievedPoints: 15, hasEvidenceReference: true, evidenceRefs: ["doc-2"] },
      { sectionKey: "equipo", achievedPoints: 15, hasEvidenceReference: true, evidenceRefs: ["doc-3"] },
    ]);
    expect(result.totalAchieved).toBe(50);
    expect(result.percentage).toBe(100);
    expect(result.meetsMinimumTechnical).toBe(true);
    expect(result.bySection.every((s) => !s.flagged)).toBe(true);
  });

  it("un rubro sin evidencia evaluada puntúa 0 (fail-closed, nunca asume cumplimiento)", () => {
    const result = simulateTechnicalScore(RUBRIC_50, [
      { sectionKey: "experiencia", achievedPoints: 20, hasEvidenceReference: true, evidenceRefs: ["doc-1"] },
      { sectionKey: "metodologia", achievedPoints: 15, hasEvidenceReference: true, evidenceRefs: ["doc-2"] },
      // "equipo" nunca se evaluó
    ]);
    expect(result.totalAchieved).toBe(35);
    const equipo = result.bySection.find((s) => s.key === "equipo")!;
    expect(equipo.achievedPoints).toBe(0);
    expect(equipo.flagged).toBe(true);
    expect(equipo.rejectedUnsourcedClaim).toBe(false); // no es un falso "cumple", es ausencia de evaluación
  });

  it('rechaza un falso "cumple": puntos > 0 sin ninguna referencia de evidencia (REQ-038)', () => {
    const result = simulateTechnicalScore(RUBRIC_50, [
      { sectionKey: "experiencia", achievedPoints: 20, hasEvidenceReference: false },
      { sectionKey: "metodologia", achievedPoints: 15, hasEvidenceReference: true, evidenceRefs: ["doc-2"] },
      { sectionKey: "equipo", achievedPoints: 15, hasEvidenceReference: true, evidenceRefs: ["doc-3"] },
    ]);
    const experiencia = result.bySection.find((s) => s.key === "experiencia")!;
    expect(experiencia.achievedPoints).toBe(0);
    expect(experiencia.rejectedUnsourcedClaim).toBe(true);
    expect(result.totalAchieved).toBe(30);
  });

  it("acota (clamp) puntos reportados fuera de rango [0, maxPoints]", () => {
    const result = simulateTechnicalScore(RUBRIC_50, [
      { sectionKey: "experiencia", achievedPoints: 999, hasEvidenceReference: true, evidenceRefs: ["doc-1"] },
      { sectionKey: "metodologia", achievedPoints: -5, hasEvidenceReference: true, evidenceRefs: ["doc-2"] },
      { sectionKey: "equipo", achievedPoints: 15, hasEvidenceReference: true, evidenceRefs: ["doc-3"] },
    ]);
    const experiencia = result.bySection.find((s) => s.key === "experiencia")!;
    const metodologia = result.bySection.find((s) => s.key === "metodologia")!;
    expect(experiencia.achievedPoints).toBe(20);
    expect(experiencia.flagged).toBe(true);
    expect(metodologia.achievedPoints).toBe(0);
    expect(metodologia.flagged).toBe(true);
  });

  it("meetsMinimumTechnical es null cuando la rúbrica no declara mínimo", () => {
    const rubricSinMinimo: ScoringRubric = { ...RUBRIC_50, minimumTechnicalPoints: undefined };
    const result = simulateTechnicalScore(rubricSinMinimo, [
      { sectionKey: "experiencia", achievedPoints: 5, hasEvidenceReference: true, evidenceRefs: ["doc-1"] },
    ]);
    expect(result.meetsMinimumTechnical).toBeNull();
  });

  it("meetsMinimumTechnical es false por debajo del mínimo declarado", () => {
    const result = simulateTechnicalScore(RUBRIC_50, [
      { sectionKey: "experiencia", achievedPoints: 5, hasEvidenceReference: true, evidenceRefs: ["doc-1"] },
    ]);
    expect(result.totalAchieved).toBe(5);
    expect(result.meetsMinimumTechnical).toBe(false);
  });

  it("propaga los problemas de validación de la rúbrica en el resultado", () => {
    const broken: ScoringRubric = { ...RUBRIC_50, economicMaxPoints: 40 };
    const result = simulateTechnicalScore(broken, []);
    expect(result.rubricIssues.map((i) => i.code)).toContain("TOTAL_NOT_100");
  });
});

describe("runScoreSimulatorBenchmark (REQ-038: exactitud ≥0.85, 0 falsos cumple)", () => {
  it("sobre el gold matrix SINTÉTICO completo (incluye 2 casos que plantan un falso cumple a propósito): exactitud 100% pero el umbral falla por los falsos cumple detectados", () => {
    const result = runScoreSimulatorBenchmark(SYNTHETIC_SCORE_GOLDMATRIX);
    expect(result.n).toBe(SYNTHETIC_SCORE_GOLDMATRIX.length);
    expect(result.exactMatches).toBe(SYNTHETIC_SCORE_GOLDMATRIX.length);
    expect(result.accuracy).toBe(1);
    // casos "4-falso-cumple-rechazado" (1 rubro) y "9-multiples-falsos-cumple" (2 rubros) = 3 rechazos
    expect(result.falseCumpleRejections).toBe(3);
    // el umbral de aceptación exige 0 falsos cumple, así que un gold matrix
    // con ataques plantados a propósito NO debe pasar la puerta, aunque la
    // exactitud numérica sea perfecta -- eso demuestra que la puerta
    // realmente combina ambas condiciones, no solo la exactitud.
    expect(result.meetsAcceptanceThreshold).toBe(false);
  });

  it("sobre un gold matrix curado (sin intentos de falso cumple) sí cumple el umbral de REQ-038", () => {
    const curated = SYNTHETIC_SCORE_GOLDMATRIX.filter((c) => !c.id.includes("falso"));
    const result = runScoreSimulatorBenchmark(curated);
    expect(result.falseCumpleRejections).toBe(0);
    expect(result.accuracy).toBeGreaterThanOrEqual(SCORE_SIMULATOR_ACCURACY_THRESHOLD);
    expect(result.meetsAcceptanceThreshold).toBe(true);
  });

  it("un gold matrix vacío no fabrica una exactitud engañosa (se reporta 0, nunca 1 por vacuidad)", () => {
    const result = runScoreSimulatorBenchmark([]);
    expect(result.n).toBe(0);
    expect(result.accuracy).toBe(0);
    expect(result.meetsAcceptanceThreshold).toBe(false);
  });

  it("un caso donde el motor no reproduce el puntaje esperado por el humano cuenta como fallo, no como coincidencia parcial", () => {
    const wrongCase = {
      id: "mal-anotado",
      rubric: RUBRIC_50,
      evidence: [{ sectionKey: "experiencia", achievedPoints: 20, hasEvidenceReference: true, evidenceRefs: ["doc-1"] }],
      expectedTotalAchieved: 999, // deliberadamente distinto de lo que el motor va a calcular (20)
    };
    const result = runScoreSimulatorBenchmark([wrongCase]);
    expect(result.exactMatches).toBe(0);
    expect(result.accuracy).toBe(0);
    expect(result.perCase[0].matched).toBe(false);
  });
});
