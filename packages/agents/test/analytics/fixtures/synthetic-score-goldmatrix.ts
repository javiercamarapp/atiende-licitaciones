import type { GoldMatrixCase, ScoringRubric } from "../../../src/analytics/score-simulator.js";

/**
 * GOLD MATRIX SINTÉTICO -- NO SON CONVOCATORIAS REALES.
 *
 * 10 casos inventados a mano (rúbrica + evidencia + puntaje esperado) para
 * probar `runScoreSimulatorBenchmark()` de punta a punta: cumplimiento
 * total, parcial, rúbrica de 60 puntos, un rubro sin evidencia evaluada, y
 * un intento de falso "cumple" (que el motor debe rechazar a 0). No
 * certifica el criterio real de REQ-038 (exactitud ≥0.85 sobre gold
 * matrix real de una convocatoria evaluada por un comité real), que sigue
 * pendiente del gold set humano (REQ-021).
 */

const RUBRIC_50: ScoringRubric = {
  technicalSections: [
    { key: "experiencia", label: "Experiencia específica", maxPoints: 20 },
    { key: "metodologia", label: "Propuesta de trabajo / metodología", maxPoints: 15 },
    { key: "equipo", label: "Equipo de trabajo propuesto", maxPoints: 15 },
  ],
  technicalTotalPoints: 50,
  economicMaxPoints: 50,
  minimumTechnicalPoints: 37.5,
};

const RUBRIC_60: ScoringRubric = {
  technicalSections: [
    { key: "experiencia", label: "Experiencia específica", maxPoints: 25 },
    { key: "metodologia", label: "Propuesta de trabajo / metodología", maxPoints: 20 },
    { key: "equipo", label: "Equipo de trabajo propuesto", maxPoints: 15 },
  ],
  technicalTotalPoints: 60,
  economicMaxPoints: 40,
  minimumTechnicalPoints: 45,
};

export const SYNTHETIC_SCORE_GOLDMATRIX: GoldMatrixCase[] = [
  {
    id: "1-cumplimiento-total-50",
    rubric: RUBRIC_50,
    evidence: [
      { sectionKey: "experiencia", achievedPoints: 20, hasEvidenceReference: true, evidenceRefs: ["doc-1"] },
      { sectionKey: "metodologia", achievedPoints: 15, hasEvidenceReference: true, evidenceRefs: ["doc-2"] },
      { sectionKey: "equipo", achievedPoints: 15, hasEvidenceReference: true, evidenceRefs: ["doc-3"] },
    ],
    expectedTotalAchieved: 50,
  },
  {
    id: "2-parcial-50",
    rubric: RUBRIC_50,
    evidence: [
      { sectionKey: "experiencia", achievedPoints: 12, hasEvidenceReference: true, evidenceRefs: ["doc-1"] },
      { sectionKey: "metodologia", achievedPoints: 10, hasEvidenceReference: true, evidenceRefs: ["doc-2"] },
      { sectionKey: "equipo", achievedPoints: 5, hasEvidenceReference: true, evidenceRefs: ["doc-3"] },
    ],
    expectedTotalAchieved: 27,
  },
  {
    id: "3-sin-evidencia-un-rubro",
    rubric: RUBRIC_50,
    evidence: [
      { sectionKey: "experiencia", achievedPoints: 20, hasEvidenceReference: true, evidenceRefs: ["doc-1"] },
      { sectionKey: "metodologia", achievedPoints: 15, hasEvidenceReference: true, evidenceRefs: ["doc-2"] },
      // "equipo" nunca fue evaluado -> fail-closed, puntúa 0
    ],
    expectedTotalAchieved: 35,
  },
  {
    id: "4-falso-cumple-rechazado",
    rubric: RUBRIC_50,
    evidence: [
      { sectionKey: "experiencia", achievedPoints: 20, hasEvidenceReference: false }, // reportado sin evidencia -> se rechaza a 0
      { sectionKey: "metodologia", achievedPoints: 15, hasEvidenceReference: true, evidenceRefs: ["doc-2"] },
      { sectionKey: "equipo", achievedPoints: 15, hasEvidenceReference: true, evidenceRefs: ["doc-3"] },
    ],
    expectedTotalAchieved: 30,
  },
  {
    id: "5-cero-total",
    rubric: RUBRIC_50,
    evidence: [
      { sectionKey: "experiencia", achievedPoints: 0, hasEvidenceReference: false },
      { sectionKey: "metodologia", achievedPoints: 0, hasEvidenceReference: false },
      { sectionKey: "equipo", achievedPoints: 0, hasEvidenceReference: false },
    ],
    expectedTotalAchieved: 0,
  },
  {
    id: "6-cumplimiento-total-60",
    rubric: RUBRIC_60,
    evidence: [
      { sectionKey: "experiencia", achievedPoints: 25, hasEvidenceReference: true, evidenceRefs: ["doc-1"] },
      { sectionKey: "metodologia", achievedPoints: 20, hasEvidenceReference: true, evidenceRefs: ["doc-2"] },
      { sectionKey: "equipo", achievedPoints: 15, hasEvidenceReference: true, evidenceRefs: ["doc-3"] },
    ],
    expectedTotalAchieved: 60,
  },
  {
    id: "7-parcial-60-bajo-minimo",
    rubric: RUBRIC_60,
    evidence: [
      { sectionKey: "experiencia", achievedPoints: 10, hasEvidenceReference: true, evidenceRefs: ["doc-1"] },
      { sectionKey: "metodologia", achievedPoints: 8, hasEvidenceReference: true, evidenceRefs: ["doc-2"] },
      { sectionKey: "equipo", achievedPoints: 5, hasEvidenceReference: true, evidenceRefs: ["doc-3"] },
    ],
    expectedTotalAchieved: 23,
  },
  {
    id: "8-parcial-60-sobre-minimo",
    rubric: RUBRIC_60,
    evidence: [
      { sectionKey: "experiencia", achievedPoints: 20, hasEvidenceReference: true, evidenceRefs: ["doc-1"] },
      { sectionKey: "metodologia", achievedPoints: 18, hasEvidenceReference: true, evidenceRefs: ["doc-2"] },
      { sectionKey: "equipo", achievedPoints: 12, hasEvidenceReference: true, evidenceRefs: ["doc-3"] },
    ],
    expectedTotalAchieved: 50,
  },
  {
    id: "9-multiples-falsos-cumple",
    rubric: RUBRIC_60,
    evidence: [
      { sectionKey: "experiencia", achievedPoints: 25, hasEvidenceReference: false },
      { sectionKey: "metodologia", achievedPoints: 20, hasEvidenceReference: false },
      { sectionKey: "equipo", achievedPoints: 15, hasEvidenceReference: true, evidenceRefs: ["doc-3"] },
    ],
    expectedTotalAchieved: 15,
  },
  {
    id: "10-cumplimiento-total-50-bis",
    rubric: RUBRIC_50,
    evidence: [
      { sectionKey: "experiencia", achievedPoints: 18, hasEvidenceReference: true, evidenceRefs: ["doc-1"] },
      { sectionKey: "metodologia", achievedPoints: 12, hasEvidenceReference: true, evidenceRefs: ["doc-2"] },
      { sectionKey: "equipo", achievedPoints: 8, hasEvidenceReference: true, evidenceRefs: ["doc-3"] },
    ],
    expectedTotalAchieved: 38,
  },
];
