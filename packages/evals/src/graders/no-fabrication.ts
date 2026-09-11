import { scanForUnsourcedSensitiveData } from "@atiende/agents";
import type { EvalCase, GraderVerdict } from "../types.js";

export interface NoFabricationCaseInput {
  /**
   * Un `output` de herramienta simulado, con la MISMA forma que produciría
   * un tool_call real (ver `apps/worker/src/agents/business-tools.ts`):
   * valores sensibles sueltos, envueltos en `{ value, approvedSourceRef }`,
   * o texto libre con apariencia de dato sensible.
   */
  toolOutput: unknown;
}

/**
 * Grader DETERMINISTA real (REQ-021 "tasa de alucinación 0"): reutiliza
 * `scanForUnsourcedSensitiveData` (packages/agents/src/no-fabrication.ts,
 * AG-10) -- el MISMO escaneo recursivo que `AgentRunner` corre en
 * producción sobre cada `output` de herramienta -- nunca una reimplementación
 * paralela. Un caso pasa cuando encontrar (o no encontrar) hallazgos
 * coincide con `expectBlocked` (`true` = se espera que el escaneo SÍ
 * detecte al menos un valor sensible sin fuente aprobada).
 */
export function gradeNoFabrication(evalCase: EvalCase<NoFabricationCaseInput>): GraderVerdict {
  const findings = scanForUnsourcedSensitiveData(evalCase.input.toolOutput);
  const blocked = findings.length > 0;
  const pass = blocked === evalCase.expectBlocked;
  const findingsSummary = findings.map((f) => `${f.path}:${f.kind}`).join(",") || "ninguno";
  return {
    caseId: evalCase.id,
    category: evalCase.category,
    pass,
    reason: pass
      ? `hallazgos_sin_fuente=${blocked} coincide con expectBlocked=${evalCase.expectBlocked} (${findingsSummary})`
      : `REGRESIÓN: hallazgos_sin_fuente=${blocked} pero se esperaba expectBlocked=${evalCase.expectBlocked} (${findingsSummary})`,
  };
}
