import { sourceKey, type TenderRecord } from "../types/tender-record.js";
import { normalizeText, normalizedIncludes } from "../util/text.js";
import type {
  EligibilityCriterionResult,
  EligibilityResult,
  EligibilityStatus,
  MatchCriterionResult,
  MatchResult,
  OrganizationProfile,
} from "./types.js";

export interface MatchWeights {
  classifiers: number;
  keywords: number;
  budget: number;
  entities: number;
  states: number;
}

export const DEFAULT_WEIGHTS: MatchWeights = {
  classifiers: 35,
  keywords: 30,
  budget: 15,
  entities: 10,
  states: 10,
};

/**
 * Motor de matching determinista (sin LLM, REQ-006 componente léxico/reglas
 * duras): perfil de organización -> score 0-100 con explicación por
 * criterio. Solo participan en el score los criterios que el perfil define;
 * los pesos de los criterios ausentes se redistribuyen proporcionalmente
 * entre los presentes, para no penalizar a una organización que aún no
 * configuró todos los criterios.
 */
export class MatchingEngine {
  private readonly weights: MatchWeights;

  constructor(weights: Partial<MatchWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  score(record: TenderRecord, profile: OrganizationProfile): MatchResult {
    const eligibility = this.evaluateEligibility(record, profile);
    const applicable: Array<{ criterion: MatchCriterionResult["criterion"]; weight: number; compute: () => MatchCriterionResult }> = [];

    if (profile.classifierCodes && profile.classifierCodes.length > 0) {
      applicable.push({ criterion: "classifiers", weight: this.weights.classifiers, compute: () => this.scoreClassifiers(record, profile) });
    }
    if (profile.keywords && profile.keywords.length > 0) {
      applicable.push({ criterion: "keywords", weight: this.weights.keywords, compute: () => this.scoreKeywords(record, profile) });
    }
    if (profile.budgetRange && (profile.budgetRange.min !== undefined || profile.budgetRange.max !== undefined)) {
      applicable.push({ criterion: "budget", weight: this.weights.budget, compute: () => this.scoreBudget(record, profile) });
    }
    if (profile.entities && profile.entities.length > 0) {
      applicable.push({ criterion: "entities", weight: this.weights.entities, compute: () => this.scoreEntities(record, profile) });
    }
    if (profile.states && profile.states.length > 0) {
      applicable.push({ criterion: "states", weight: this.weights.states, compute: () => this.scoreStates(record, profile) });
    }

    if (applicable.length === 0) {
      return {
        tenderKey: sourceKey(record),
        score: 0,
        criteria: [
          { criterion: "keywords", score: 0, maxScore: 0, explanation: "El perfil de la organización no define ningún criterio de matching." },
        ],
        eligibility,
      };
    }

    const totalWeight = applicable.reduce((sum, a) => sum + a.weight, 0);
    const criteria: MatchCriterionResult[] = [];
    let totalScore = 0;

    for (const { weight, compute } of applicable) {
      const normalizedWeight = (weight / totalWeight) * 100;
      const raw = compute();
      const scaledScore = raw.maxScore === 0 ? 0 : (raw.score / raw.maxScore) * normalizedWeight;
      criteria.push({ ...raw, maxScore: normalizedWeight, score: round2(scaledScore) });
      totalScore += scaledScore;
    }

    // Exclusión dura: palabras clave excluidas anulan el match sin importar el resto.
    if (profile.excludedKeywords?.some((kw) => normalizedIncludes(record.title, kw))) {
      criteria.push({
        criterion: "keywords",
        score: -100,
        maxScore: 0,
        explanation: `El título contiene una palabra clave excluida por la organización.`,
      });
      return { tenderKey: sourceKey(record), score: 0, criteria, eligibility };
    }

    return { tenderKey: sourceKey(record), score: round2(clamp(totalScore, 0, 100)), criteria, eligibility };
  }

  /**
   * Evalúa elegibilidad (REQ-168): requisitos duros configurados por el
   * perfil — presupuesto, cobertura geográfica (estados) y exclusiones —
   * como un valor INDEPENDIENTE de la relevancia/score léxico. Dato
   * ausente en la convocatoria SIEMPRE produce "no_evaluable" para ese
   * criterio, nunca "cumple" ni "no_cumple" inventados.
   */
  private evaluateEligibility(record: TenderRecord, profile: OrganizationProfile): EligibilityResult {
    const criteria: EligibilityCriterionResult[] = [];

    if (profile.budgetRange && (profile.budgetRange.min !== undefined || profile.budgetRange.max !== undefined)) {
      if (record.budgetAmount === undefined) {
        criteria.push({
          requirement: "budget",
          status: "no_evaluable",
          explanation:
            "La convocatoria no publica presupuesto/monto estimado; no es posible determinar si cumple el rango " +
            "configurado por la organización (dato ausente nunca se marca elegible por defecto).",
        });
      } else {
        const { min, max } = profile.budgetRange;
        const within = (min === undefined || record.budgetAmount >= min) && (max === undefined || record.budgetAmount <= max);
        criteria.push({
          requirement: "budget",
          status: within ? "cumple" : "no_cumple",
          explanation: within
            ? `Presupuesto ${record.budgetAmount} ${record.currency} dentro del rango configurado [${min ?? "-∞"}, ${max ?? "∞"}].`
            : `Presupuesto ${record.budgetAmount} ${record.currency} fuera del rango configurado [${min ?? "-∞"}, ${max ?? "∞"}].`,
        });
      }
    }

    if (profile.states && profile.states.length > 0) {
      if (!record.state) {
        criteria.push({
          requirement: "states",
          status: "no_evaluable",
          explanation: "La convocatoria no especifica entidad federativa; no es posible determinar si cae dentro de la cobertura geográfica configurada.",
        });
      } else {
        const matched = profile.states.some((s) => normalizeText(s) === normalizeText(record.state!));
        criteria.push({
          requirement: "states",
          status: matched ? "cumple" : "no_cumple",
          explanation: matched
            ? `El estado "${record.state}" está dentro de la cobertura geográfica configurada.`
            : `El estado "${record.state}" no está dentro de la cobertura geográfica configurada (${profile.states.join(", ")}).`,
        });
      }
    }

    if (profile.excludedKeywords && profile.excludedKeywords.length > 0) {
      const hit = profile.excludedKeywords.find((kw) => normalizedIncludes(record.title, kw));
      criteria.push({
        requirement: "excludedKeywords",
        status: hit ? "no_cumple" : "cumple",
        explanation: hit
          ? `El título contiene la palabra clave excluida "${hit}" configurada por la organización.`
          : "El título no contiene ninguna palabra clave excluida por la organización.",
      });
    }

    return { status: aggregateEligibility(criteria), criteria };
  }

  private scoreClassifiers(record: TenderRecord, profile: OrganizationProfile): MatchCriterionResult {
    const wanted = profile.classifierCodes ?? [];
    if (record.classifiers.length === 0) {
      return { criterion: "classifiers", score: 0, maxScore: 1, explanation: "La convocatoria no trae clasificador (CUCoP/UNSPSC/CPV); no evaluable." };
    }
    const matches = record.classifiers.filter((c) => wanted.some((w) => c.code.startsWith(w) || w.startsWith(c.code)));
    if (matches.length > 0) {
      return {
        criterion: "classifiers",
        score: 1,
        maxScore: 1,
        explanation: `Clasificador ${matches.map((m) => m.code).join(", ")} coincide con el perfil (${wanted.join(", ")}).`,
      };
    }
    return {
      criterion: "classifiers",
      score: 0,
      maxScore: 1,
      explanation: `Ningún clasificador (${record.classifiers.map((c) => c.code).join(", ")}) coincide con el perfil (${wanted.join(", ")}).`,
    };
  }

  private scoreKeywords(record: TenderRecord, profile: OrganizationProfile): MatchCriterionResult {
    const keywords = profile.keywords ?? [];
    const haystack = `${record.title} ${record.procedureTypeRaw ?? ""}`;
    const matched = keywords.filter((kw) => normalizedIncludes(haystack, kw));
    return {
      criterion: "keywords",
      score: matched.length,
      maxScore: keywords.length,
      explanation:
        matched.length > 0
          ? `Coincidieron ${matched.length}/${keywords.length} palabras clave: ${matched.join(", ")}.`
          : `Ninguna de las ${keywords.length} palabras clave del perfil aparece en el título.`,
    };
  }

  private scoreBudget(record: TenderRecord, profile: OrganizationProfile): MatchCriterionResult {
    const range = profile.budgetRange!;
    if (record.budgetAmount === undefined) {
      return { criterion: "budget", score: 0.5, maxScore: 1, explanation: "Presupuesto no disponible en la convocatoria; se asigna score neutro." };
    }
    const amount = record.budgetAmount;
    const withinMin = range.min === undefined || amount >= range.min;
    const withinMax = range.max === undefined || amount <= range.max;
    if (withinMin && withinMax) {
      return { criterion: "budget", score: 1, maxScore: 1, explanation: `Presupuesto ${amount} ${record.currency} dentro del rango configurado.` };
    }
    return {
      criterion: "budget",
      score: 0,
      maxScore: 1,
      explanation: `Presupuesto ${amount} ${record.currency} fuera del rango configurado [${range.min ?? "-∞"}, ${range.max ?? "∞"}].`,
    };
  }

  private scoreEntities(record: TenderRecord, profile: OrganizationProfile): MatchCriterionResult {
    const entities = profile.entities ?? [];
    const matched = entities.find((e) => normalizeText(record.contractingEntity).includes(normalizeText(e)));
    return {
      criterion: "entities",
      score: matched ? 1 : 0,
      maxScore: 1,
      explanation: matched
        ? `La entidad convocante "${record.contractingEntity}" coincide con "${matched}" del perfil.`
        : `La entidad convocante "${record.contractingEntity}" no está en la lista de interés del perfil.`,
    };
  }

  private scoreStates(record: TenderRecord, profile: OrganizationProfile): MatchCriterionResult {
    const states = profile.states ?? [];
    if (!record.state) {
      return { criterion: "states", score: 0.5, maxScore: 1, explanation: "La convocatoria no especifica entidad federativa; score neutro." };
    }
    const matched = states.some((s) => normalizeText(s) === normalizeText(record.state!));
    return {
      criterion: "states",
      score: matched ? 1 : 0,
      maxScore: 1,
      explanation: matched
        ? `El estado "${record.state}" está en la lista de cobertura del perfil.`
        : `El estado "${record.state}" no está en la lista de cobertura del perfil (${states.join(", ")}).`,
    };
  }
}

/**
 * Agrega el resultado de todos los criterios de elegibilidad configurados:
 * "no_cumple" tiene prioridad (un solo requisito duro incumplido basta para
 * descalificar); si ninguno incumple pero al menos uno es "no_evaluable",
 * el agregado es "no_evaluable" (nunca se "redondea" a "cumple" con datos
 * incompletos); "cumple" solo si TODOS los criterios configurados cumplen.
 * Si no hay ningún criterio de elegibilidad configurado, el agregado es
 * "no_evaluable" (nunca se asume "cumple" por defecto ante la ausencia
 * total de configuración).
 */
function aggregateEligibility(criteria: EligibilityCriterionResult[]): EligibilityStatus {
  if (criteria.length === 0) return "no_evaluable";
  if (criteria.some((c) => c.status === "no_cumple")) return "no_cumple";
  if (criteria.some((c) => c.status === "no_evaluable")) return "no_evaluable";
  return "cumple";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
