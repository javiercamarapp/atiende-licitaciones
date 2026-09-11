import { describe, expect, it } from "vitest";
import { assertApprovalRequestAllowed, buildAuditReport, canCreateApprovalRequest } from "../../src/audit/audit-report.js";
import type { AuditInput } from "../../src/audit/gates.js";
import { AuditJudge } from "../../src/audit/judge.js";
import { ProviderRouter } from "../../src/llm/router.js";
import { FakeProvider } from "../../src/llm/fake-provider.js";
import { AuditBlockedError } from "../../src/errors.js";
import type { LLMCompletionRequest, LLMCompletionResult } from "../../src/llm/provider.js";

function cleanInput(): AuditInput {
  return {
    packageId: "pkg-1",
    organizationId: "org-1",
    complianceMatrix: [{ id: "req-1", obligatoriedad: "obligatorio", status: "cumplido" }],
    hasUnresolvedConflicts: false,
    claims: [{ id: "claim-1", text: "Contamos con ISO 9001 vigente.", sourceDocIds: ["doc-1"] }],
    knownEvidenceDocIds: ["doc-1"],
    economicLineItems: [{ concept: "instalacion", quantity: 1, unitPriceCents: 10_000n, subtotalCents: 10_000n }],
    economicTotals: { subtotalCents: 10_000n, ivaRate: 0.16, ivaCents: 1_600n, totalCents: 11_600n },
    requiredSections: ["tecnica"],
    presentSections: ["tecnica"],
    technicalCommitmentConcepts: ["instalacion"],
  };
}

function judgeWithScript(script: (request: LLMCompletionRequest) => LLMCompletionResult): AuditJudge {
  const router = new ProviderRouter(new FakeProvider(script));
  return new AuditJudge({ router, model: "modelo-juez-test" });
}

const okVerdictScript = () => ({
  content: JSON.stringify({ resumenEjecutivo: "paquete conforme", advertenciasAdicionales: [] }),
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 },
});

describe("buildAuditReport — caso SIN bloqueos (REQ-037, caso positivo)", () => {
  it("blocking=[] y el juez SÍ se invoca, aportando solo warnings", async () => {
    let judgeCalled = false;
    const judge = judgeWithScript(() => {
      judgeCalled = true;
      return okVerdictScript();
    });
    const report = await buildAuditReport(cleanInput(), judge);

    expect(report.blocking).toEqual([]);
    expect(judgeCalled).toBe(true);
    expect(report.judge).not.toBeNull();
    expect(report.judge?.status).toBe("ok");
    expect(canCreateApprovalRequest(report)).toBe(true);
    expect(() => assertApprovalRequestAllowed(report)).not.toThrow();
  });

  it("las advertencias del juez se reflejan en warnings, nunca en blocking", async () => {
    const judge = judgeWithScript(() => ({
      content: JSON.stringify({ resumenEjecutivo: "conforme con observaciones", advertenciasAdicionales: ["redacción ambigua en cláusula 7"] }),
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const report = await buildAuditReport(cleanInput(), judge);
    expect(report.blocking).toEqual([]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0].source).toBe("juez_llm");
    expect(report.warnings[0].message).toContain("redacción ambigua");
  });

  it("una salida de juez inválida se convierte en warning, no en blocking (nunca se fabrica un veredicto)", async () => {
    const judge = judgeWithScript(() => ({ content: "no es json", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }));
    const report = await buildAuditReport(cleanInput(), judge);
    expect(report.blocking).toEqual([]);
    expect(report.judge?.status).toBe("salida_invalida");
    expect(report.warnings.map((w) => w.code)).toContain("juez_salida_invalida");
    expect(canCreateApprovalRequest(report)).toBe(true);
  });
});

describe("buildAuditReport — caso CON bloqueos (REQ-037, caso negativo)", () => {
  it("blocking no vacío, el juez LLM NUNCA se invoca, y approval_request se rechaza", async () => {
    let judgeCalled = false;
    const judge = judgeWithScript(() => {
      judgeCalled = true;
      return okVerdictScript();
    });
    const input = cleanInput();
    input.complianceMatrix = [{ id: "req-1", obligatoriedad: "obligatorio", status: "pendiente" }];

    const report = await buildAuditReport(input, judge);

    expect(report.blocking.length).toBeGreaterThan(0);
    expect(judgeCalled).toBe(false); // REQ-037: los 5 gates corren ANTES que cualquier juez LLM
    expect(report.judge).toBeNull();
    expect(canCreateApprovalRequest(report)).toBe(false);
    expect(() => assertApprovalRequestAllowed(report)).toThrow(AuditBlockedError);
  });

  it("acumula bloqueos de varios gates a la vez en una sola corrida (no se detiene en el primero)", async () => {
    const judge = judgeWithScript(okVerdictScript);
    const input = cleanInput();
    input.complianceMatrix = [{ id: "req-1", obligatoriedad: "obligatorio", status: "pendiente" }];
    input.claims = [{ id: "claim-x", text: "afirmación sin fuente", sourceDocIds: [] }];

    const report = await buildAuditReport(input, judge);
    const sources = new Set(report.blocking.map((f) => f.source));
    expect(sources.has("matriz_completa")).toBe(true);
    expect(sources.has("citas_evidencia_real")).toBe(true);
  });

  it("AuditBlockedError trae los códigos de bloqueo para diagnóstico", async () => {
    const judge = judgeWithScript(okVerdictScript);
    const input = cleanInput();
    input.presentSections = [];
    const report = await buildAuditReport(input, judge);
    try {
      assertApprovalRequestAllowed(report);
      throw new Error("no debió llegar aquí");
    } catch (err) {
      expect(err).toBeInstanceOf(AuditBlockedError);
      expect((err as AuditBlockedError).blockingCodes).toContain("seccion_faltante");
    }
  });
});
