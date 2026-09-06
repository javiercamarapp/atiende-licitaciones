import type { TenderRecord } from "../types/tender-record.js";

export interface BudgetRange {
  min?: number;
  max?: number;
}

/**
 * Perfil de una organización cliente contra el que se evalúan las
 * convocatorias descubiertas. Todos los campos son opcionales: un criterio
 * sin configurar simplemente no participa en el score (no penaliza).
 */
export interface OrganizationProfile {
  id: string;
  /** Prefijos de clasificador (CUCoP/UNSPSC/CPV) de interés; empareja por prefijo (jerarquía del catálogo). */
  classifierCodes?: string[];
  keywords?: string[];
  excludedKeywords?: string[];
  /** Entidades convocantes preferentes (coincidencia normalizada, subcadena). */
  entities?: string[];
  budgetRange?: BudgetRange;
  /** Estados (entidades federativas) donde la organización opera. */
  states?: string[];
}

export interface MatchCriterionResult {
  criterion: "classifiers" | "keywords" | "budget" | "entities" | "states";
  score: number;
  maxScore: number;
  explanation: string;
}

/**
 * Estado de cumplimiento de UN requisito duro de elegibilidad (REQ-168,
 * distinto de `MatchCriterionResult`/`score`, que mide relevancia/afinidad
 * temática). "no_evaluable" es el estado obligatorio cuando falta el dato
 * necesario para decidir — NUNCA se infiere "cumple" ni "no_cumple" por
 * ausencia de dato (AMPLIACION-BACKOFFICE §4: "ausencia de dato =
 * pendiente/no evaluable, nunca elegible inventado").
 */
export type EligibilityStatus = "cumple" | "no_cumple" | "no_evaluable";

export interface EligibilityCriterionResult {
  /** Referencia al requisito evaluado (REQ-168: "con referencia al requisito"). */
  requirement: "budget" | "states" | "excludedKeywords";
  status: EligibilityStatus;
  explanation: string;
}

export interface EligibilityResult {
  /**
   * Agregado de todos los criterios de elegibilidad configurados:
   * "no_cumple" si CUALQUIERA no cumple (tiene prioridad); si no,
   * "no_evaluable" si CUALQUIERA no es evaluable (incluye el caso sin
   * ningún criterio configurado: nunca se asume "cumple" por defecto);
   * "cumple" solo si todos los criterios configurados cumplen.
   */
  status: EligibilityStatus;
  criteria: EligibilityCriterionResult[];
}

/**
 * `score`/`criteria` miden RELEVANCIA (afinidad temática/léxica, 0-100,
 * REQ-006/007 parcial). `eligibility` mide CUMPLIMIENTO DE REQUISITOS DUROS
 * (presupuesto/cobertura geográfica/exclusiones) como un valor
 * INDEPENDIENTE (REQ-168, AMPLIACION-BACKOFFICE §4: "el matching expone
 * relevancia... y elegibilidad... como puntuaciones separadas y
 * explicables, nunca un score único que las mezcle"). Un consumidor NUNCA
 * debe inferir elegibilidad a partir de `score` (p.ej. "score alto = sí se
 * puede participar"): debe leer `eligibility` explícitamente.
 */
export interface MatchResult {
  tenderKey: string;
  score: number;
  criteria: MatchCriterionResult[];
  eligibility: EligibilityResult;
}

/**
 * Punto de extensión para enriquecer la explicación con LLM en una fase
 * posterior (fuera de alcance de este paquete: el score en sí SIEMPRE debe
 * seguir siendo determinista, el LLM solo puede narrar, nunca recalcular).
 */
export interface MatchExplanationEnricher {
  enrich(result: MatchResult, record: TenderRecord): Promise<string>;
}
