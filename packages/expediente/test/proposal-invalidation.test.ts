import { beforeEach, describe, expect, it } from "vitest";
import { ApprovalWorkflow, resetApprovalCounters } from "../src/approval-workflow.js";
import { CompanyDataService, InMemoryCompanyDataResolver } from "../src/company-data.js";
import { EconomicProposalBuilder } from "../src/economic-proposal.js";
import { PackageAssembler, type AssembleInput } from "../src/package-assembler.js";
import { ProposalVersionRegistry, type ExpedienteInputs } from "../src/proposal-version.js";
import { sha256Hex } from "../src/types.js";
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
    currentInputsHash: "",
    ...overrides,
  };
}

/**
 * EX-EXP-01/EX-EXP-11: `ExpedienteInputs` es el conjunto CERRADO y
 * OBLIGATORIO que `ProposalVersionRegistry.createVersion` exige — ya no se
 * puede hashear solo `economicTotals` "olvidando" el resto de insumos. Este
 * helper arma un `ExpedienteInputs` base realista; cada test sobreescribe
 * SOLO el insumo que quiere cambiar entre v1/v2.
 */
function baseExpedienteInputs(overrides: Partial<ExpedienteInputs> = {}): ExpedienteInputs {
  return {
    tenderVersionHash: "bases-v1",
    companyProfileHash: "empresa-1-perfil-v1",
    companyDocuments: [{ documentId: "doc-32d", hash: "opinion-32d-hash-v1", vigenteHasta: "2026-12-01T00:00:00-06:00" }],
    rates: [{ concept: "consultoria_hora", hash: "850.00" }],
    templates: [{ templateId: "carta-propuesta", hash: "plantilla-v1" }],
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
    const versionV1 = versions.createVersion(baseExpedienteInputs({ rates: [{ concept: "consultoria_hora", hash: "850.00" }] }));

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

    const versionV2 = versions.createVersion(baseExpedienteInputs({ rates: [{ concept: "consultoria_hora", hash: "2550.00" }] }));
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
    const { manifest } = await assembler.assemble(assembleInputFor({ approvals: staleApprovals, currentInputsHash: versionV2.hash }));

    expect(manifest.status).toBe("draft");
    expect(manifest.watermark).toBe("BORRADOR");
    expect(manifest.draftReasons.some((r) => r.includes("hash_insumos_divergente"))).toBe(true);

    // 5. Con la aprobación YA invalidada automáticamente (paso 4a), el
    // ensamblado normal (usando el estado real post-revalidación) también
    // queda en "draft".
    const { manifest: manifestReal } = await assembler.assemble(
      assembleInputFor({ approvals: workflow.listApprovals(), currentInputsHash: versionV2.hash }),
    );
    expect(manifestReal.status).toBe("draft");
  });
});

/**
 * EX-EXP-11 (ALTA, reverificación ronda 1 — generalización de EX-EXP-01): el
 * fix original solo protegía el vector EXACTO reproducido por el auditor
 * (una tarifa). Se demostró que sustituir un documento de empresa o
 * publicar una nueva versión de bases DESPUÉS de aprobar, sin que el
 * llamador los incluyera "a mano" en el hash, dejaba la aprobación
 * ciega al cambio porque `createVersion` aceptaba cualquier
 * `Record<string, unknown>` arbitrario. Ahora `createVersion` exige
 * `ExpedienteInputs` — un conjunto cerrado de 5 categorías que TypeScript
 * fuerza a declarar completo — así que CUALQUIER insumo de esas categorías
 * que cambie, cambia el hash automáticamente, sin que el llamador tenga que
 * acordarse de incluirlo.
 */
describe("EX-EXP-11: el hash de insumos generaliza a CUALQUIER insumo del conjunto cerrado, no solo la tarifa", () => {
  beforeEach(() => resetApprovalCounters());

  it("un documento de empresa (acta constitutiva) sustituido DESPUÉS de aprobar invalida la aprobación aunque la tarifa no haya cambiado", () => {
    const versions = new ProposalVersionRegistry();
    const versionV1 = versions.createVersion(
      baseExpedienteInputs({ companyDocuments: [{ documentId: "acta-constitutiva", hash: "acta-original", vigenteHasta: null }] }),
    );

    const workflow = new ApprovalWorkflow();
    workflow.requestReview({ scopeRef: "expediente", actorId: "user-writer", actorRole: "writer" });
    workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: versionV1.hash });
    expect(workflow.isFullyApproved()).toBe(true);

    // ATAQUE: se sustituye el acta constitutiva por otra versión; NINGÚN
    // otro insumo cambia (misma tarifa, mismas bases, mismo perfil).
    const versionV2 = versions.createVersion(
      baseExpedienteInputs({ companyDocuments: [{ documentId: "acta-constitutiva", hash: "acta-sustituida-tras-aprobacion", vigenteHasta: null }] }),
    );
    expect(versionV2.hash).not.toBe(versionV1.hash);

    expect(workflow.isFullyApprovedForCurrentHash(versionV2.hash)).toBe(false);
    expect(workflow.listApprovals()[0].status).toBe("invalidada");
  });

  it("una nueva versión de bases (convocatoria v2) publicada DESPUÉS de aprobar invalida la aprobación aunque nada más cambie", () => {
    const versions = new ProposalVersionRegistry();
    const versionV1 = versions.createVersion(baseExpedienteInputs({ tenderVersionHash: "bases-convocatoria-v1" }));

    const workflow = new ApprovalWorkflow();
    workflow.requestReview({ scopeRef: "expediente", actorId: "user-writer", actorRole: "writer" });
    workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: versionV1.hash });
    expect(workflow.isFullyApproved()).toBe(true);

    // ATAQUE: se publica una nueva versión de las bases (convocatoria v2).
    const versionV2 = versions.createVersion(baseExpedienteInputs({ tenderVersionHash: "bases-convocatoria-v2" }));
    expect(versionV2.hash).not.toBe(versionV1.hash);

    expect(workflow.isFullyApprovedForCurrentHash(versionV2.hash)).toBe(false);
    expect(workflow.listApprovals()[0].status).toBe("invalidada");
  });

  it("dos objetos con las mismas claves en distinto orden siguen produciendo el MISMO hash (stableStringify, no es una debilidad)", () => {
    const versions = new ProposalVersionRegistry();
    const a = versions.createVersion(baseExpedienteInputs({ rates: [{ concept: "z_concepto", hash: "1" }, { concept: "a_concepto", hash: "2" }] }));
    const b = new ProposalVersionRegistry().createVersion(
      baseExpedienteInputs({ rates: [{ concept: "a_concepto", hash: "2" }, { concept: "z_concepto", hash: "1" }] }),
    );
    expect(a.hash).toBe(b.hash);
  });

  it("una clave con valor undefined ya NO colisiona con la misma clave ausente (EX-EXP-11: colisión de serialización)", () => {
    // No pasa por ExpedienteInputs (que es un tipo cerrado): reproduce el
    // hallazgo directamente sobre `stableStringify`/`sha256Hex`, la causa
    // raíz señalada por la reverificación.
    const withUndefinedKey = { total: "100.00", descuento: undefined };
    const withoutKey = { total: "100.00" };
    // Antes del fix: JSON.stringify descartaba la clave `undefined` y ambos
    // objetos producían el mismo hash pese a ser lógicamente distintos.
    expect(sha256Hex(withUndefinedKey)).not.toBe(sha256Hex(withoutKey));
  });
});

/**
 * EX-EXP-01/EX-EXP-11: `ProposalVersionRegistry.inputChanged()`,
 * `getVersion()`, `latest()` y `all()` quedaban sin ejercitar por ningún
 * test (33.33% de funciones cubiertas, 0 referencias a `inputChanged` fuera
 * de su propia definición). Ahora `changedInputsSince` los conecta a un uso
 * real: reporta QUÉ insumo específico cambió, no solo que "algo" cambió.
 */
describe("ProposalVersionRegistry: getVersion/latest/all/inputChanged/changedInputsSince (cobertura EX-EXP-01/EX-EXP-11)", () => {
  it("getVersion/latest/all exponen el historial completo de versiones", () => {
    const versions = new ProposalVersionRegistry();
    const v1 = versions.createVersion(baseExpedienteInputs());
    const v2 = versions.createVersion(baseExpedienteInputs({ rates: [{ concept: "consultoria_hora", hash: "999.00" }] }));

    expect(versions.getVersion(1)).toEqual(v1);
    expect(versions.getVersion(2)).toEqual(v2);
    expect(versions.getVersion(3)).toBeUndefined();
    expect(versions.latest()).toEqual(v2);
    expect(versions.all()).toEqual([v1, v2]);
  });

  it("changedInputsSince reporta exactamente la clave del insumo que cambió, no solo que el hash difiere", () => {
    const versions = new ProposalVersionRegistry();
    const v1 = versions.createVersion(baseExpedienteInputs());

    const changedRate = versions.changedInputsSince(v1, baseExpedienteInputs({ rates: [{ concept: "consultoria_hora", hash: "999.00" }] }));
    expect(changedRate).toEqual(["rate:consultoria_hora"]);

    const changedDoc = versions.changedInputsSince(
      v1,
      baseExpedienteInputs({ companyDocuments: [{ documentId: "doc-32d", hash: "otro-hash", vigenteHasta: "2026-12-01T00:00:00-06:00" }] }),
    );
    expect(changedDoc).toEqual(["company_document:doc-32d"]);

    expect(versions.changedInputsSince(v1, baseExpedienteInputs())).toEqual([]);
  });

  it("changedInputsSince reporta un insumo retirado (ya no presente) como cambio", () => {
    const versions = new ProposalVersionRegistry();
    const v1 = versions.createVersion(baseExpedienteInputs());
    const changed = versions.changedInputsSince(v1, baseExpedienteInputs({ companyDocuments: [] }));
    expect(changed).toContain("company_document:doc-32d");
  });

  it("inputChanged() (static) detecta un insumo nuevo que no existía en la versión registrada", () => {
    const versions = new ProposalVersionRegistry();
    const v1 = versions.createVersion(baseExpedienteInputs());
    expect(ProposalVersionRegistry.inputChanged(v1, "insumo_inexistente", "cualquier valor")).toBe(true);
    expect(ProposalVersionRegistry.inputChanged(v1, "tender_version", "bases-v1")).toBe(false);
    expect(ProposalVersionRegistry.inputChanged(v1, "tender_version", "bases-v2-distinta")).toBe(true);
  });

  it("createVersion rechaza ExpedienteInputs incompletos en runtime (defensa contra llamadores que burlen TypeScript)", () => {
    const versions = new ProposalVersionRegistry();
    // @ts-expect-error prueba deliberada de un objeto incompleto (sin companyDocuments/rates/templates)
    expect(() => versions.createVersion({ tenderVersionHash: "x", companyProfileHash: "y" })).toThrow(/obligatorio/);
  });
});
