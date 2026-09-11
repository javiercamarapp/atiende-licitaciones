/**
 * Los 5 gates deterministas del auditor (REQ-037: "5 puertas deterministas
 * antes de cualquier juez LLM: matriz completa, citas a evidencia real,
 * consistencia numérica, formato, coherencia técnica-económica"). Se
 * ejecutan SIEMPRE los 5, en este orden fijo, sin excepción y sin llamar a
 * ningún LLM: son código puro, reproducible al 100% (no "determinista salvo
 * por la temperatura del modelo"). El juez LLM (`audit/judge.ts`) solo se
 * invoca cuando los 5 pasan (`AuditReport.blocking = []`) — ver
 * `buildAuditReport` en `audit-report.ts`.
 *
 * Estas interfaces son deliberadamente genéricas (no importan tipos de
 * `packages/expediente`, con el que `packages/agents` no tiene dependencia
 * — ver `package.json`): cada llamador (hoy `apps/worker`/`apps/api`, aún
 * no conectado) proyecta sus tipos reales de expediente/matriz/propuesta a
 * este `AuditInput` explícito.
 */

import { multiplyRateHalfUpCents, sumCents } from "./money.js";

export type AuditGateName =
  | "matriz_completa"
  | "citas_evidencia_real"
  | "consistencia_numerica"
  | "formato"
  | "coherencia_tecnica_economica";

export const AUDIT_GATE_NAMES: readonly AuditGateName[] = [
  "matriz_completa",
  "citas_evidencia_real",
  "consistencia_numerica",
  "formato",
  "coherencia_tecnica_economica",
];

/** Fuente de un `AuditFinding`: uno de los 5 gates deterministas, o el juez LLM (solo puede aportar `warnings`, nunca `blocking` — ver `audit-report.ts`). */
export type AuditFindingSource = AuditGateName | "juez_llm";

export interface AuditFinding {
  source: AuditFindingSource;
  /** Código estable, snake_case, para agrupar/alertar sin parsear el mensaje humano. */
  code: string;
  message: string;
}

export interface AuditGateResult {
  gate: AuditGateName;
  passed: boolean;
  findings: AuditFinding[];
}

// ---------------------------------------------------------------------------
// Gate 1: matriz completa
// ---------------------------------------------------------------------------

export type AuditObligatoriedad = "obligatorio" | "opcional" | "condicional";
export type AuditRequirementStatus = "pendiente" | "en_progreso" | "cumplido" | "bloqueado" | "no_evaluable";

export interface AuditComplianceMatrixItem {
  id: string;
  obligatoriedad: AuditObligatoriedad;
  status: AuditRequirementStatus;
}

function checkMatrizCompleta(items: readonly AuditComplianceMatrixItem[], hasUnresolvedConflicts: boolean): AuditGateResult {
  const findings: AuditFinding[] = [];

  if (items.length === 0) {
    findings.push({
      source: "matriz_completa",
      code: "matriz_vacia",
      message: "La matriz de cumplimiento está vacía: no se puede certificar que el paquete cumpla requisitos que nunca se extrajeron.",
    });
  }

  for (const item of items) {
    if (item.obligatoriedad === "obligatorio" && item.status !== "cumplido") {
      findings.push({
        source: "matriz_completa",
        code: "requisito_obligatorio_incompleto",
        message: `El requisito obligatorio "${item.id}" no está "cumplido" (estado actual: "${item.status}").`,
      });
    }
  }

  if (hasUnresolvedConflicts) {
    findings.push({
      source: "matriz_completa",
      code: "conflictos_sin_resolver",
      message: "Existen conflictos entre documentos de la matriz de requisitos (p. ej. plazos contradictorios) sin escalar/resolver por un humano.",
    });
  }

  return { gate: "matriz_completa", passed: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Gate 2: citas a evidencia real
// ---------------------------------------------------------------------------

export interface AuditClaim {
  id: string;
  text: string;
  sourceDocIds: string[];
}

function checkCitasEvidenciaReal(claims: readonly AuditClaim[], knownEvidenceDocIds: ReadonlySet<string>): AuditGateResult {
  const findings: AuditFinding[] = [];

  for (const claim of claims) {
    if (claim.sourceDocIds.length === 0) {
      findings.push({
        source: "citas_evidencia_real",
        code: "claim_sin_fuente",
        message: `El claim "${claim.id}" ("${claim.text.slice(0, 80)}") no cita ninguna fuente de evidencia.`,
      });
      continue;
    }
    for (const docId of claim.sourceDocIds) {
      if (!knownEvidenceDocIds.has(docId)) {
        findings.push({
          source: "citas_evidencia_real",
          code: "cita_evidencia_inexistente",
          message: `El claim "${claim.id}" cita la fuente "${docId}", que no existe en la bóveda de evidencia real de este expediente.`,
        });
      }
    }
  }

  return { gate: "citas_evidencia_real", passed: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Gate 3: consistencia numérica
// ---------------------------------------------------------------------------

export interface AuditEconomicLineItem {
  concept: string;
  /** Cantidad entera (unidades/servicios). Cantidades fraccionarias están fuera del alcance de este gate — ver `cantidad_no_entera`. */
  quantity: number;
  unitPriceCents: bigint;
  subtotalCents: bigint;
}

export interface AuditEconomicTotals {
  subtotalCents: bigint;
  ivaRate: number;
  ivaCents: bigint;
  totalCents: bigint;
}

function checkConsistenciaNumerica(
  lineItems: readonly AuditEconomicLineItem[],
  totals: AuditEconomicTotals | null,
): AuditGateResult {
  const findings: AuditFinding[] = [];

  if (totals === null) {
    findings.push({
      source: "consistencia_numerica",
      code: "totales_economicos_ausentes",
      message: "No hay totales económicos declarados: no se puede auditar consistencia numérica sobre un vacío (nunca se asume $0).",
    });
    return { gate: "consistencia_numerica", passed: false, findings };
  }

  for (const line of lineItems) {
    if (!Number.isInteger(line.quantity) || line.quantity < 0) {
      findings.push({
        source: "consistencia_numerica",
        code: "cantidad_no_entera",
        message: `La partida "${line.concept}" tiene cantidad no entera o negativa (${line.quantity}); este gate solo audita cantidades enteras no negativas.`,
      });
      continue;
    }
    const expectedSubtotal = line.unitPriceCents * BigInt(line.quantity);
    if (expectedSubtotal !== line.subtotalCents) {
      findings.push({
        source: "consistencia_numerica",
        code: "subtotal_de_partida_inconsistente",
        message: `La partida "${line.concept}": ${line.quantity} × ${line.unitPriceCents}¢ = ${expectedSubtotal}¢, pero el subtotal declarado es ${line.subtotalCents}¢.`,
      });
    }
  }

  const validLines = lineItems.filter((l) => Number.isInteger(l.quantity) && l.quantity >= 0);
  const computedSubtotal = sumCents(validLines.map((l) => l.subtotalCents));
  if (computedSubtotal !== totals.subtotalCents) {
    findings.push({
      source: "consistencia_numerica",
      code: "subtotal_total_inconsistente",
      message: `La suma de subtotales de partidas (${computedSubtotal}¢) no coincide con el subtotal declarado (${totals.subtotalCents}¢).`,
    });
  }

  const computedIva = multiplyRateHalfUpCents(totals.subtotalCents, totals.ivaRate);
  if (computedIva !== totals.ivaCents) {
    findings.push({
      source: "consistencia_numerica",
      code: "iva_inconsistente",
      message: `IVA recalculado (${totals.subtotalCents}¢ × ${totals.ivaRate}, half-up) = ${computedIva}¢, pero el IVA declarado es ${totals.ivaCents}¢.`,
    });
  }

  const computedTotal = totals.subtotalCents + totals.ivaCents;
  if (computedTotal !== totals.totalCents) {
    findings.push({
      source: "consistencia_numerica",
      code: "total_inconsistente",
      message: `Subtotal + IVA (${computedTotal}¢) no coincide con el total declarado (${totals.totalCents}¢).`,
    });
  }

  return { gate: "consistencia_numerica", passed: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Gate 4: formato
// ---------------------------------------------------------------------------

function checkFormato(requiredSections: readonly string[], presentSections: readonly string[]): AuditGateResult {
  const present = new Set(presentSections);
  const findings: AuditFinding[] = [];
  for (const section of requiredSections) {
    if (!present.has(section)) {
      findings.push({
        source: "formato",
        code: "seccion_faltante",
        message: `Falta la sección obligatoria "${section}" en el paquete ensamblado.`,
      });
    }
  }
  return { gate: "formato", passed: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Gate 5: coherencia técnica-económica
// ---------------------------------------------------------------------------

function checkCoherenciaTecnicaEconomica(
  technicalCommitmentConcepts: readonly string[],
  economicLineItems: readonly AuditEconomicLineItem[],
): AuditGateResult {
  const technical = new Set(technicalCommitmentConcepts);
  const economic = new Set(economicLineItems.map((l) => l.concept));
  const findings: AuditFinding[] = [];

  for (const concept of technical) {
    if (!economic.has(concept)) {
      findings.push({
        source: "coherencia_tecnica_economica",
        code: "compromiso_tecnico_sin_precio",
        message: `La propuesta técnica se compromete a "${concept}" pero la propuesta económica no lo cotiza: el compromiso no podría cumplirse sin costo capturado.`,
      });
    }
  }
  for (const concept of economic) {
    if (!technical.has(concept)) {
      findings.push({
        source: "coherencia_tecnica_economica",
        code: "partida_economica_sin_respaldo_tecnico",
        message: `La propuesta económica cotiza "${concept}" pero la propuesta técnica no lo respalda como compromiso: posible partida sin sustento o error de captura.`,
      });
    }
  }

  return { gate: "coherencia_tecnica_economica", passed: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Orquestación de los 5 gates
// ---------------------------------------------------------------------------

export interface AuditInput {
  packageId: string;
  organizationId: string | null;
  complianceMatrix: AuditComplianceMatrixItem[];
  hasUnresolvedConflicts: boolean;
  claims: AuditClaim[];
  knownEvidenceDocIds: string[];
  economicLineItems: AuditEconomicLineItem[];
  economicTotals: AuditEconomicTotals | null;
  requiredSections: string[];
  presentSections: string[];
  technicalCommitmentConcepts: string[];
}

/**
 * Ejecuta los 5 gates deterministas EN ORDEN FIJO, siempre los 5 completos
 * (nunca se detiene en el primer fallo): un `AuditReport` con múltiples
 * bloqueos a la vez es más útil para un revisor humano que descubrirlos uno
 * por uno en corridas sucesivas.
 */
export function runAuditGates(input: AuditInput): AuditGateResult[] {
  return [
    checkMatrizCompleta(input.complianceMatrix, input.hasUnresolvedConflicts),
    checkCitasEvidenciaReal(input.claims, new Set(input.knownEvidenceDocIds)),
    checkConsistenciaNumerica(input.economicLineItems, input.economicTotals),
    checkFormato(input.requiredSections, input.presentSections),
    checkCoherenciaTecnicaEconomica(input.technicalCommitmentConcepts, input.economicLineItems),
  ];
}
