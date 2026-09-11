/**
 * Simulador determinista de puntaje (REQ-020) + simulador del evaluador
 * (REQ-038): aplica la rúbrica de "puntos y porcentajes" de una
 * convocatoria específica sobre evidencia YA evaluada (por un analista o
 * checklist upstream, nunca inventada aquí) y produce el puntaje técnico
 * resultante. No es un LLM: es aritmética y validación de reglas, la
 * única autoridad de la cifra (mismo ADR que `price-band.ts` -- nunca
 * delegar cálculo de puntaje a un LLM).
 *
 * Dos garantías centrales del REQ:
 *  - REQ-020: la suma de los rubros técnicos debe ser 50 o 60 puntos
 *    (`validateRubric` lo verifica siempre, no solo en el "camino feliz").
 *  - REQ-038 ("0 falsos cumple"): un rubro con puntos > 0 pero SIN
 *    ninguna referencia de evidencia citada se rechaza y se puntúa en 0,
 *    en vez de aceptar la cifra reportada a ciegas -- fail-closed, mismo
 *    patrón de "no fabricación" del resto del repo.
 */

export interface ScoringRubricSection {
  key: string;
  label: string;
  /** Puntos máximos de este rubro, tal como lo publica la convocatoria. */
  maxPoints: number;
}

/** REQ-020: el total de puntos técnicos siempre es 50 o 60 (lineamiento de puntos y porcentajes). */
export type TechnicalRubricTotal = 50 | 60;

export interface ScoringRubric {
  technicalSections: ScoringRubricSection[];
  technicalTotalPoints: TechnicalRubricTotal;
  /** Puntos máximos de la propuesta económica (usualmente 100 - technicalTotalPoints). */
  economicMaxPoints: number;
  /**
   * Puntaje técnico mínimo para no quedar descalificado (REQ-108 cita
   * 37.5/45 del lineamiento SFP 2010 -- **VERIFICAR** vigencia antes de
   * usar esos valores por defecto en producción, ver docs/REQUISITOS.md
   * REQ-108; este motor nunca asume un mínimo, solo lo aplica si se le
   * declara explícitamente).
   */
  minimumTechnicalPoints?: number;
}

export interface RubricValidationIssue {
  code: "SECTION_SUM_MISMATCH" | "INVALID_TOTAL" | "TOTAL_NOT_100" | "NON_POSITIVE_SECTION" | "DUPLICATE_SECTION_KEY" | "NO_SECTIONS";
  message: string;
}

/**
 * Valida la estructura de la rúbrica en sí (independiente de cualquier
 * evidencia): REQ-020 exige que la suma de rubros dé exactamente 50 o 60
 * en el 100% de los casos, no solo "cerca".
 */
export function validateRubric(rubric: ScoringRubric): RubricValidationIssue[] {
  const issues: RubricValidationIssue[] = [];

  if (rubric.technicalSections.length === 0) {
    issues.push({ code: "NO_SECTIONS", message: "La rúbrica no declara ningún rubro técnico." });
  }

  const sumSections = rubric.technicalSections.reduce((s, sec) => s + sec.maxPoints, 0);
  if (Math.abs(sumSections - rubric.technicalTotalPoints) > 1e-9) {
    issues.push({
      code: "SECTION_SUM_MISMATCH",
      message: `La suma de los rubros técnicos (${sumSections}) no coincide con el total declarado (${rubric.technicalTotalPoints}).`,
    });
  }

  if (rubric.technicalTotalPoints !== 50 && rubric.technicalTotalPoints !== 60) {
    issues.push({
      code: "INVALID_TOTAL",
      message: `El total de puntos técnicos debe ser 50 o 60 (REQ-020); se recibió ${rubric.technicalTotalPoints}.`,
    });
  }

  const combined = rubric.technicalTotalPoints + rubric.economicMaxPoints;
  if (Math.abs(combined - 100) > 1e-9) {
    issues.push({
      code: "TOTAL_NOT_100",
      message: `Técnica (${rubric.technicalTotalPoints}) + económica (${rubric.economicMaxPoints}) debe sumar 100 puntos; sumó ${combined}.`,
    });
  }

  if (rubric.technicalSections.some((s) => s.maxPoints <= 0)) {
    issues.push({ code: "NON_POSITIVE_SECTION", message: "Todo rubro debe declarar maxPoints > 0." });
  }

  const keys = rubric.technicalSections.map((s) => s.key);
  if (new Set(keys).size !== keys.length) {
    issues.push({ code: "DUPLICATE_SECTION_KEY", message: "Hay rubros con la misma key; cada rubro debe tener una key única." });
  }

  return issues;
}

export interface SectionEvidence {
  sectionKey: string;
  /** Puntos que el analista/checklist upstream evaluó que se obtienen en este rubro. */
  achievedPoints: number;
  /** `true` solo si hay al menos una referencia de evidencia real citada para ese puntaje. */
  hasEvidenceReference: boolean;
  evidenceRefs?: string[];
}

export interface SectionScoreResult {
  key: string;
  label: string;
  maxPoints: number;
  achievedPoints: number;
  /** `true` si este rubro sufrió un ajuste automático (ver `flagReason`). */
  flagged: boolean;
  flagReason?: string;
  /** `true` específicamente cuando se rechazó un puntaje > 0 reportado sin evidencia (REQ-038: "0 falsos cumple"). */
  rejectedUnsourcedClaim: boolean;
}

export interface ScoreSimulationResult {
  rubricIssues: RubricValidationIssue[];
  bySection: SectionScoreResult[];
  totalAchieved: number;
  totalPossible: number;
  percentage: number;
  /** `null` si la rúbrica no declaró `minimumTechnicalPoints`. */
  meetsMinimumTechnical: boolean | null;
}

/**
 * Aplica la rúbrica técnica sobre la evidencia ya evaluada de cada rubro.
 * No decide POR SÍ SOLA si un requisito se cumple -- eso lo hace el
 * analista/checklist que produce `SectionEvidence[]` -- pero SÍ es la
 * única autoridad de la ARITMÉTICA resultante, y aplica dos redes de
 * seguridad deterministas:
 *
 *  1. Un rubro sin evidencia evaluada puntúa 0 (fail-closed: nunca se
 *     asume cumplimiento por ausencia de dato).
 *  2. Un rubro con `achievedPoints > 0` pero `hasEvidenceReference: false`
 *     se RECHAZA (puntúa 0, `rejectedUnsourcedClaim: true`) -- un falso
 *     "cumple" nunca pasa silenciosamente (REQ-038).
 */
export function simulateTechnicalScore(rubric: ScoringRubric, evidence: SectionEvidence[]): ScoreSimulationResult {
  const rubricIssues = validateRubric(rubric);
  const evidenceByKey = new Map(evidence.map((e) => [e.sectionKey, e]));

  const bySection: SectionScoreResult[] = rubric.technicalSections.map((section) => {
    const ev = evidenceByKey.get(section.key);

    if (!ev) {
      return {
        key: section.key,
        label: section.label,
        maxPoints: section.maxPoints,
        achievedPoints: 0,
        flagged: true,
        flagReason: "Sin evidencia evaluada para este rubro; se puntúa 0 (fail-closed, nunca se asume cumplimiento).",
        rejectedUnsourcedClaim: false,
      };
    }

    if (ev.achievedPoints > 0 && !ev.hasEvidenceReference) {
      return {
        key: section.key,
        label: section.label,
        maxPoints: section.maxPoints,
        achievedPoints: 0,
        flagged: true,
        flagReason: `Se reportaron ${ev.achievedPoints} puntos sin ninguna referencia de evidencia citada; rechazado como falso "cumple" (REQ-038) y puntuado en 0.`,
        rejectedUnsourcedClaim: true,
      };
    }

    const clamped = Math.min(Math.max(ev.achievedPoints, 0), section.maxPoints);
    const outOfRange = clamped !== ev.achievedPoints;
    return {
      key: section.key,
      label: section.label,
      maxPoints: section.maxPoints,
      achievedPoints: clamped,
      flagged: outOfRange,
      flagReason: outOfRange
        ? `Puntos reportados (${ev.achievedPoints}) fuera de rango [0, ${section.maxPoints}]; se acotó a ${clamped}.`
        : undefined,
      rejectedUnsourcedClaim: false,
    };
  });

  const totalAchieved = bySection.reduce((s, sec) => s + sec.achievedPoints, 0);
  const totalPossible: number = rubric.technicalTotalPoints;
  // `totalPossible` es 50 o 60 por tipo (`TechnicalRubricTotal`), nunca 0 -- pero
  // un caller en JS puro (o un dato mal capturado que burla el tipo, ver
  // `validateRubric`/INVALID_TOTAL) sí podría entregar 0 en runtime; se
  // guarda la división por cero de todas formas en vez de asumir el tipo.
  const percentage = totalPossible === 0 ? 0 : (totalAchieved / totalPossible) * 100;
  const meetsMinimumTechnical = rubric.minimumTechnicalPoints === undefined ? null : totalAchieved >= rubric.minimumTechnicalPoints;

  return { rubricIssues, bySection, totalAchieved, totalPossible, percentage, meetsMinimumTechnical };
}

/**
 * Caso de una "gold matrix" (REQ-038: "exactitud del simulador ≥0.85 y 0
 * falsos cumple sobre gold matrix"): una rúbrica + evidencia reales de una
 * convocatoria ya evaluada por un evaluador humano, junto con el puntaje
 * que el evaluador real determinó.
 */
export interface GoldMatrixCase {
  id: string;
  rubric: ScoringRubric;
  evidence: SectionEvidence[];
  /** Puntaje técnico total que el evaluador humano real determinó para este caso. */
  expectedTotalAchieved: number;
}

export interface GoldMatrixBenchmarkResult {
  n: number;
  exactMatches: number;
  accuracy: number;
  /** Número de rubros rechazados por falso "cumple" en TODO el gold matrix -- REQ-038 exige que sea 0. */
  falseCumpleRejections: number;
  meetsAcceptanceThreshold: boolean;
  perCase: Array<{ id: string; achieved: number; expected: number; matched: boolean; falseCumpleRejections: number }>;
}

export const SCORE_SIMULATOR_ACCURACY_THRESHOLD = 0.85;

/**
 * Corre el simulador contra un "gold matrix" y calcula exactitud
 * (coincidencia exacta del puntaje total) + conteo de rubros rechazados
 * por falso "cumple". `meetsAcceptanceThreshold` refleja literalmente el
 * criterio de REQ-038: exactitud ≥0.85 Y 0 falsos "cumple" en el propio
 * gold matrix (un falso "cumple" en los DATOS de entrada del gold matrix
 * indicaría un gold matrix mal curado, no un fallo del motor -- por eso se
 * reporta por separado del conteo de exactitud).
 */
export function runScoreSimulatorBenchmark(cases: GoldMatrixCase[]): GoldMatrixBenchmarkResult {
  const perCase = cases.map((c) => {
    const result = simulateTechnicalScore(c.rubric, c.evidence);
    const falseCumpleRejections = result.bySection.filter((s) => s.rejectedUnsourcedClaim).length;
    return {
      id: c.id,
      achieved: result.totalAchieved,
      expected: c.expectedTotalAchieved,
      matched: result.totalAchieved === c.expectedTotalAchieved,
      falseCumpleRejections,
    };
  });

  const exactMatches = perCase.filter((c) => c.matched).length;
  const accuracy = cases.length === 0 ? 0 : exactMatches / cases.length;
  const falseCumpleRejections = perCase.reduce((s, c) => s + c.falseCumpleRejections, 0);

  return {
    n: cases.length,
    exactMatches,
    accuracy,
    falseCumpleRejections,
    meetsAcceptanceThreshold: accuracy >= SCORE_SIMULATOR_ACCURACY_THRESHOLD && falseCumpleRejections === 0,
    perCase,
  };
}
