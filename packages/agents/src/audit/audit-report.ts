/**
 * `AuditReport` (REQ-037): orquesta los 5 gates deterministas de `gates.ts`
 * y, SOLO si los 5 pasan, invoca al juez LLM determinista de `judge.ts`.
 * Criterio de aceptación literal (docs/ACEPTACION.md REQ-037):
 * "`AuditReport{blocking[]}` vacío es condición necesaria para crear
 * `approval_request`, verificado en casos de prueba con y sin bloqueos".
 *
 * `blocking[]` SOLO puede venir de los 5 gates deterministas — el juez LLM
 * jamás puede poblarlo (ver `AuditFindingSource`, `gates.ts`): esto es lo
 * que hace que "blocking=[] => se puede crear approval_request" sea una
 * propiedad verificable con pruebas 100% deterministas (`FakeProvider` con
 * script), sin depender de la disponibilidad ni del comportamiento real de
 * ningún proveedor LLM para las pruebas negativas del gate.
 */

import { AuditBlockedError } from "../errors.js";
import { isoNow } from "../types.js";
import { runAuditGates, type AuditFinding, type AuditGateResult, type AuditInput } from "./gates.js";
import type { AuditJudge, AuditJudgeOutcome } from "./judge.js";

export interface AuditReport {
  packageId: string;
  organizationId: string | null;
  generatedAt: string;
  gates: AuditGateResult[];
  blocking: AuditFinding[];
  warnings: AuditFinding[];
  /** `null` cuando algún gate bloqueó: el juez LLM NUNCA se invoca en ese caso (REQ-037: los 5 gates corren "antes de cualquier juez LLM"). */
  judge: AuditJudgeOutcome | null;
}

/**
 * Construye el `AuditReport` completo. Ejecuta los 5 gates primero,
 * siempre; si alguno bloquea, retorna de inmediato SIN llamar al juez
 * (ahorra costo y evita exponer datos de un paquete que de todos modos no
 * puede aprobarse). Si los 5 pasan, invoca al juez y traduce su veredicto a
 * `warnings` — nunca a `blocking`.
 */
export async function buildAuditReport(input: AuditInput, judge: AuditJudge): Promise<AuditReport> {
  const gates = runAuditGates(input);
  const blocking = gates.flatMap((g) => g.findings);
  const generatedAt = isoNow();
  const base = { packageId: input.packageId, organizationId: input.organizationId, generatedAt, gates };

  if (blocking.length > 0) {
    return { ...base, blocking, warnings: [], judge: null };
  }

  const outcome = await judge.evaluate(input);
  const warnings: AuditFinding[] =
    outcome.status === "ok"
      ? outcome.verdict.advertenciasAdicionales.map((message, index) => ({
          source: "juez_llm" as const,
          code: `juez_advertencia_${index + 1}`,
          message,
        }))
      : [
          {
            source: "juez_llm" as const,
            code: "juez_salida_invalida",
            message:
              "El juez LLM no devolvió un veredicto en el esquema esperado; su comentario no está disponible en esta corrida. No afecta blocking[] (ya vacío por los 5 gates deterministas), pero el resumen ejecutivo del juez no debe asumirse presente.",
          },
        ];

  return { ...base, blocking: [], warnings, judge: outcome };
}

/**
 * REQ-037 literal: única vía permitida para decidir si un `AuditReport`
 * autoriza crear un `approval_request`. Nunca inspeccionar
 * `report.blocking.length` directamente en el código de llamada — pasar
 * siempre por aquí, para que la invariante quede en un solo lugar
 * auditable.
 */
export function assertApprovalRequestAllowed(report: AuditReport): true {
  if (report.blocking.length > 0) {
    throw new AuditBlockedError(report.blocking.map((f) => f.code));
  }
  return true;
}

export function canCreateApprovalRequest(report: AuditReport): boolean {
  return report.blocking.length === 0;
}
