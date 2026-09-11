import type { EvalCase } from "../types.js";
import type { JudgeCaseInput } from "../graders/llm-judge.js";

/**
 * Categoría "juicio_calidad_redaccion": ejercita el PUERTO `LLMJudge` (ver
 * graders/llm-judge.ts) con el mismo tipo de texto que produce
 * `proponer_seccion_propuesta` (apps/worker/src/agents/business-tools.ts) --
 * un borrador que cita experiencia real de `experience_records`.
 *
 * NO CALIBRADO contra un gold set humano real (REQ-021 bloqueado, ver
 * README.md "Cobertura real vs pendiente"): estos casos prueban que el
 * MECANISMO de umbral funciona de extremo a extremo (runner + juez +
 * threshold), no que el juicio de calidad esté certificado.
 */
export const JUDGE_CASES: EvalCase<JudgeCaseInput>[] = [
  {
    id: "jz-01-cita-correcta-y-respaldada",
    category: "juicio_calidad_redaccion",
    description: "El borrador cita exactamente la experiencia real, respaldada por la fuente.",
    input: {
      candidateText:
        "Nuestra empresa cuenta con experiencia relevante: Construcción de puente vehicular sobre el Río Verde (Municipio de Tultepec).",
      requiredFacts: ["Construcción de puente vehicular sobre el Río Verde", "Municipio de Tultepec"],
      sourceText: "Experiencia registrada: Construcción de puente vehicular sobre el Río Verde. Cliente: Municipio de Tultepec.",
    },
    expectBlocked: false,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "jz-02-fabricacion-dato-no-existe-en-fuente",
    category: "juicio_calidad_redaccion",
    description: "El borrador afirma un dato que NO existe en la fuente real -- alucinación clásica.",
    input: {
      candidateText: "Contamos con más de 20 años de experiencia certificada internacionalmente en obra civil de gran escala.",
      requiredFacts: ["más de 20 años de experiencia certificada internacionalmente"],
      sourceText: "Experiencia registrada: Construcción de puente vehicular sobre el Río Verde. Cliente: Municipio de Tultepec.",
    },
    expectBlocked: true,
    provenance: "fixture-sintetica-evals",
  },
  {
    id: "jz-03-cita-en-fuente-pero-no-en-borrador",
    category: "juicio_calidad_redaccion",
    description: "El dato SÍ existe en la fuente pero el borrador no lo cita textualmente (afirmación vaga sin respaldo verificable).",
    input: {
      candidateText: "Tenemos experiencia relevante en el sector.",
      requiredFacts: ["Construcción de puente vehicular sobre el Río Verde"],
      sourceText: "Experiencia registrada: Construcción de puente vehicular sobre el Río Verde. Cliente: Municipio de Tultepec.",
    },
    expectBlocked: true,
    provenance: "fixture-sintetica-evals",
  },
];
