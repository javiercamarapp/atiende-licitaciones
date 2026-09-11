/**
 * Tipos del gate de evals (REQ-087/REQ-097/REQ-138): runner de evals real +
 * su integración en CI, no un script suelto. Ver README.md de este paquete
 * para el mapeo completo requisito -> mecanismo.
 */

export type EvalCategory =
  | "anticorrupcion_anticolusion"
  | "inyeccion_prompt"
  | "no_fabricacion"
  | "autorizacion_rol"
  | "juicio_calidad_redaccion";

export const EVAL_CATEGORIES: readonly EvalCategory[] = [
  "anticorrupcion_anticolusion",
  "inyeccion_prompt",
  "no_fabricacion",
  "autorizacion_rol",
  "juicio_calidad_redaccion",
];

/**
 * Un caso de eval. `TInput` es específico de cada grader (ver
 * `src/graders/*`). Todo caso declara su `provenance`: de dónde sale el
 * texto/escenario -- en este paquete, SIEMPRE fixtures sintéticas escritas
 * a mano para ejercitar la lógica de negocio real (nunca convocatorias
 * reales: no existe todavía un gold set real, ver REQ-021/docs/BLOQUEOS.md
 * B-02 y docs/ACEPTACION.md). Declarar la procedencia en cada caso es lo
 * que permite auditar honestamente "esto es sintético" sin tener que leer
 * el texto del caso para saberlo.
 */
export interface EvalCase<TInput = unknown> {
  id: string;
  category: EvalCategory;
  description: string;
  input: TInput;
  /** true si este caso espera que el sistema BLOQUEE/DENIEGUE/marque pendiente (caso negativo/adversarial). */
  expectBlocked: boolean;
  provenance: string;
}

export interface GraderVerdict {
  caseId: string;
  category: EvalCategory;
  pass: boolean;
  reason: string;
  /** Score 0..1 del juez calibrado, cuando el grader es probabilístico (ver graders/llm-judge.ts). Ausente en graders deterministas binarios. */
  score?: number;
}

export type Grader<TInput = unknown> = (evalCase: EvalCase<TInput>) => Promise<GraderVerdict> | GraderVerdict;

export interface CategoryThreshold {
  category: EvalCategory;
  /** Tasa mínima de aciertos (0..1) para que la categoría no rompa el build. */
  minPassRate: number;
  /**
   * Si es true, un solo fallo en la categoría basta para romper el build
   * sin importar `minPassRate` (equivalente a exigir minPassRate=1 pero
   * documentando la intención: "tasa de alucinación/fabricación/fuga
   * anticorrupción tolerada = 0", REQ-021).
   */
  zeroTolerance?: boolean;
  /**
   * false cuando el grader de la categoría NO está calibrado contra un
   * gold set humano real (p. ej. `juicio_calidad_redaccion`, que usa
   * `FakeCalibratedJudge` -- ver graders/llm-judge.ts). El reporte marca
   * esas categorías explícitamente como no-calibradas; el gate igual las
   * hace cumplir (para que el mecanismo de umbral esté probado de extremo
   * a extremo), pero nunca se presenta su resultado como "juicio de
   * calidad certificado contra casos reales".
   */
  calibratedAgainstRealGoldSet: boolean;
}

export interface CategoryResult {
  category: EvalCategory;
  total: number;
  passed: number;
  passRate: number;
  threshold: CategoryThreshold;
  status: "ok" | "below_threshold";
  failures: GraderVerdict[];
}

export interface GateReport {
  generatedAt: string;
  overallStatus: "pass" | "fail";
  categories: CategoryResult[];
  totalCases: number;
  totalPassed: number;
}
