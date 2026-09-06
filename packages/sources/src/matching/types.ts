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

export interface MatchResult {
  tenderKey: string;
  score: number;
  criteria: MatchCriterionResult[];
}

/**
 * Punto de extensión para enriquecer la explicación con LLM en una fase
 * posterior (fuera de alcance de este paquete: el score en sí SIEMPRE debe
 * seguir siendo determinista, el LLM solo puede narrar, nunca recalcular).
 */
export interface MatchExplanationEnricher {
  enrich(result: MatchResult, record: TenderRecord): Promise<string>;
}
