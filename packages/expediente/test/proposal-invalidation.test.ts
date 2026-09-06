import { beforeEach, describe, expect, it } from "vitest";
import { ApprovalWorkflow, resetApprovalCounters } from "../src/approval-workflow.js";
import { CompanyDataService, InMemoryCompanyDataResolver } from "../src/company-data.js";
import { EconomicProposalBuilder } from "../src/economic-proposal.js";
import { PackageAssembler, type AssembleInput } from "../src/package-assembler.js";
import { ProposalVersionRegistry } from "../src/proposal-version.js";
import type { ChecklistReport } from "../src/integrity-checklist.js";

/**
 * EX-EXP-01 (CRÍTICA, auditoría ronda 1): reproduce end-to-end el ataque
 * exacto documentado en docs/auditoria-1/expediente.md — una tarifa que
 * cambia DESPUÉS de que el expediente fue aprobado (alcance "expediente"),
 * sin que nadie llame `ApprovalWorkflow.recordChange` manualmente, no debe
 * poder producir un `PackageManifest.status === "ready"` que refleje el
 * precio nuevo nunca aprobado. La invalidación debe ser AUTOMÁTICA: el
 * ensamblador y el flujo de aprobación recalculan el hash de insumos en
 * cada evaluación.
 */

const ASOF = "2026-10-20T12:00:00-06:00";
const COMPANY_ID = "empresa-1";

const GREEN_CHECKLIST: ChecklistReport = {
  overallStatus: "verde",
  items: [
    { dimension: "formatos", status: "verde", detail: "ok", evidence: [] },
    { dimension: "limites", status: "verde", detail: "ok", evidence: [] },
    { dimension: "firmas", status: "verde", detail: "ok", evidence: [] },
    { dimension: "anexos_obligatorios", status: "verde", detail: "ok", evidence: [] },
    { dimension: "vigencias", status: "verde", detail: "ok", evidence: [] },
    { dimension: "calculos_economicos", status: "verde", detail: "ok", evidence: [] },
    { dimension: "consistencia_cruzada", status: "verde", detail: "ok", evidence: [] },
  ],
};

function buildResolverWithRate(unitPrice: string) {
  return new InMemoryCompanyDataResolver({
    rates: [
      {
        id: "rate-consultoria",
        companyId: COMPANY_ID,
        concept: "consultoria_hora",
        unit: "hora",
        unitPrice,
        currency: "MXN",
        approvalStatus: "aprobado",
        validFrom: "2026-01-01T00:00:00-06:00",
        validUntil: null,
      },
    ],
  });
}

function assembleInputFor(overrides: Partial<AssembleInput>): AssembleInput {
  return {
    expedienteId: "expediente-2026-001",
    documents: [{ documentId: "economica", label: "Propuesta económica", required: true, filename: "economica.pdf", content: "x" }],
    checklist: GREEN_CHECKLIST,
    approvals: [],
    isFullyApproved: false,
    currentInputsHash: "",
    ...overrides,
  };
}

describe("EX-EXP-01: invalidación automática de la aprobación cuando cambia un insumo (tarifa) tras aprobar", () => {
  beforeEach(() => resetApprovalCounters());

  it("reproduce el ataque del auditor: tarifa que pasa de $850.00 a $2,550.00/hora DESPUÉS de aprobar 'expediente' produce 'draft' con motivo explícito, nunca 'ready' con el precio no aprobado", async () => {
    // 1. Estado ORIGINAL: tarifa aprobada a $850.00/hora.
    const companyServiceV1 = new CompanyDataService(buildResolverWithRate("850.00"));
    const economicV1 = new EconomicProposalBuilder(companyServiceV1, { ivaRate: 0.16 }).build(
      COMPANY_ID,
      [{ concept: "consultoria_hora", quantity: 20 }],
      ASOF,
    );
    expect(economicV1.totals?.total).toBe("19720.00"); // $19,720.00 aprobado (20h * $850 + IVA 16%)

    const versions = new ProposalVersionRegistry();
    const versionV1 = versions.createVersion({ economicTotals: economicV1.totals });

    // 2. Aprobación de alcance "expediente" contra el hash de ESE estado.
    const workflow = new ApprovalWorkflow();
    workflow.requestReview({ scopeRef: "expediente", actorId: "user-writer", actorRole: "writer" });
    const approvalResult = workflow.approve({
      scope: "expediente",
      scopeRef: "expediente",
      actorId: "user-reviewer",
      actorRole: "reviewer",
      inputsHash: versionV1.hash,
    });
    expect(approvalResult.ok).toBe(true);
    expect(workflow.isFullyApproved()).toBe(true);

    // 3. ATAQUE: la tarifa se triplica a $2,550.00/hora DESPUÉS de la
    // aprobación. Deliberadamente NO se llama `recordChange` a mano (el
    // escenario exacto que el auditor reprodujo).
    const companyServiceV2 = new CompanyDataService(buildResolverWithRate("2550.00"));
    const economicV2 = new EconomicProposalBuilder(companyServiceV2, { ivaRate: 0.16 }).build(
      COMPANY_ID,
      [{ concept: "consultoria_hora", quantity: 20 }],
      ASOF,
    );
    expect(economicV2.totals?.total).toBe("59160.00"); // el precio nuevo, NUNCA aprobado

    const versionV2 = versions.createVersion({ economicTotals: economicV2.totals });
    expect(versionV2.hash).not.toBe(versionV1.hash);

    // 4a. El FLUJO DE APROBACIÓN, al reevaluar contra el hash actual,
    // invalida automáticamente la aprobación obsoleta (sin llamada manual a
    // recordChange) y deja el evento registrado.
    const isStillApproved = workflow.isFullyApprovedForCurrentHash(versionV2.hash);
    expect(isStillApproved).toBe(false);
    expect(workflow.listApprovals()[0].status).toBe("invalidada");
    expect(workflow.listApprovals()[0].invalidatedReason).toContain("hash_insumos_divergente");
    expect(workflow.listChanges()).toHaveLength(1);

    // 4b. Incluso si un llamador de apps/api OLVIDARA invocar la
    // revalidación anterior y pasara la aprobación tal cual seguía
    // "vigente" con el hash viejo, el ENSAMBLADOR por sí solo debe negarse
    // a producir "ready" con el hash divergente (defensa en profundidad).
    const staleApprovals = [
      {
        id: "approval-stale",
        scope: "expediente" as const,
        scopeRef: "expediente",
        approvedBy: "user-reviewer",
        approvedByRole: "reviewer" as const,
        approvedAt: "2026-10-01T00:00:00-06:00",
        inputsHash: versionV1.hash,
        status: "vigente" as const,
      },
    ];
    const assembler = new PackageAssembler();
    const { manifest } = await assembler.assemble(
      assembleInputFor({ approvals: staleApprovals, isFullyApproved: true, currentInputsHash: versionV2.hash }),
    );

    expect(manifest.status).toBe("draft");
    expect(manifest.watermark).toBe("BORRADOR");
    expect(manifest.draftReasons.some((r) => r.includes("hash_insumos_divergente"))).toBe(true);

    // 5. Con la aprobación YA invalidada automáticamente (paso 4a), el
    // ensamblado normal (usando el estado real post-revalidación) también
    // queda en "draft".
    const { manifest: manifestReal } = await assembler.assemble(
      assembleInputFor({ approvals: workflow.listApprovals(), isFullyApproved: workflow.isFullyApproved(), currentInputsHash: versionV2.hash }),
    );
    expect(manifestReal.status).toBe("draft");
  });
});
