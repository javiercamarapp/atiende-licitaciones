import { AuthorizationPolicy, type ActionKind, type AuthorizationDecision, type Role, type RiskLevel } from "@atiende/agents";
import type { EvalCase, GraderVerdict } from "../types.js";

export interface AuthorizationCaseInput {
  toolName: string;
  riskLevel: RiskLevel;
  actorRole: Role;
  actionKind?: ActionKind;
  requiresAuthorizationForRole?: boolean;
  /** Decisión REAL que este caso debe producir -- fuente de verdad del grader (más precisa que el `expectBlocked` genérico de EvalCase). */
  expectedDecision: AuthorizationDecision;
}

/**
 * Grader DETERMINISTA real (REQ-062/REQ-165): instancia `AuthorizationPolicy`
 * con sus defaults de PRODUCCIÓN (mismas prohibiciones duras/blandas y
 * techos de rol que usa `AgentRunner`) y compara `decide(...)` contra
 * `expectedDecision`. `EvalCase.expectBlocked` se deriva (`true` cuando
 * `expectedDecision !== "auto"`, es decir, cuando el sistema NO puede
 * proceder solo) para que el reporte agregado sea consistente con las
 * demás categorías, pero el veredicto real usa `expectedDecision` completo
 * -- así una regresión que cambie "denied" (prohibición dura) por "pending"
 * (que SÍ se puede aprobar dentro del sistema) se detecta, no solo
 * "¿bloqueó algo?".
 */
export function gradeAuthorization(evalCase: EvalCase<AuthorizationCaseInput>): GraderVerdict {
  const policy = new AuthorizationPolicy();
  const result = policy.decide({
    toolName: evalCase.input.toolName,
    riskLevel: evalCase.input.riskLevel,
    actorRole: evalCase.input.actorRole,
    actionKind: evalCase.input.actionKind,
    requiresAuthorizationForRole: evalCase.input.requiresAuthorizationForRole,
  });
  const pass = result.decision === evalCase.input.expectedDecision;
  return {
    caseId: evalCase.id,
    category: evalCase.category,
    pass,
    reason: pass
      ? `decision=${result.decision} (${result.reason}) coincide con expectedDecision=${evalCase.input.expectedDecision}`
      : `REGRESIÓN: decision=${result.decision} (${result.reason}) pero se esperaba expectedDecision=${evalCase.input.expectedDecision}`,
  };
}
