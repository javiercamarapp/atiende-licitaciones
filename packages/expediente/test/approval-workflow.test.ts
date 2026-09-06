import { beforeEach, describe, expect, it } from "vitest";
import { ApprovalWorkflow, resetApprovalCounters } from "../src/approval-workflow.js";

describe("ApprovalWorkflow — estados y roles (REQ-159/REQ-161)", () => {
  beforeEach(() => resetApprovalCounters());

  it("transiciona borrador -> en_revision -> aprobado con roles válidos", () => {
    const wf = new ApprovalWorkflow();
    expect(wf.getState()).toBe("borrador");

    const submit = wf.requestReview({ scopeRef: "expediente", actorId: "user-writer", actorRole: "writer" });
    expect(submit.ok).toBe(true);
    expect(wf.getState()).toBe("en_revision");

    const approve = wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: "hash-1" });
    expect(approve.ok).toBe(true);
    expect(wf.getState()).toBe("aprobado");
    expect(wf.isFullyApproved()).toBe(true);
  });
});

describe("ApprovalWorkflow — A12 rol indebido (REQ-062/REQ-165)", () => {
  beforeEach(() => resetApprovalCounters());

  it("rechaza aprobación desde rol 'writer'", () => {
    const wf = new ApprovalWorkflow();
    wf.requestReview({ scopeRef: "expediente", actorId: "user-a", actorRole: "writer" });
    const result = wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-b", actorRole: "writer", inputsHash: "h" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("rol_no_autorizado_para_aprobar");
    expect(wf.getState()).not.toBe("aprobado");
  });

  it("rechaza aprobación desde rol 'viewer'", () => {
    const wf = new ApprovalWorkflow();
    wf.requestReview({ scopeRef: "expediente", actorId: "user-a", actorRole: "owner" });
    const result = wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-c", actorRole: "viewer", inputsHash: "h" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("rol_no_autorizado_para_aprobar");
  });

  it("rechaza autoaprobación: quien envió a revisión no puede aprobar su propio expediente, aunque tenga rol reviewer", () => {
    const wf = new ApprovalWorkflow();
    wf.requestReview({ scopeRef: "documento:tecnica", actorId: "user-a", actorRole: "writer" });
    const result = wf.approve({ scope: "documento", scopeRef: "documento:tecnica", actorId: "user-a", actorRole: "reviewer", inputsHash: "h" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("autoaprobacion_prohibida");
  });

  it("rechaza envío a revisión desde rol 'viewer'", () => {
    const wf = new ApprovalWorkflow();
    const result = wf.requestReview({ scopeRef: "expediente", actorId: "user-a", actorRole: "viewer" });
    expect(result.ok).toBe(false);
  });
});

describe("ApprovalWorkflow — A11 edición invalida aprobación (REQ-155/REQ-162)", () => {
  beforeEach(() => resetApprovalCounters());

  it("invalida la aprobación del expediente cuando se detecta un cambio en un insumo ya aprobado", () => {
    const wf = new ApprovalWorkflow();
    wf.requestReview({ scopeRef: "expediente", actorId: "user-writer", actorRole: "writer" });
    const approval = wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: "hash-v1" });
    expect(approval.ok).toBe(true);
    expect(wf.getState()).toBe("aprobado");

    const change = wf.recordChange({ scope: "documento", scopeRef: "documento:economica", reason: "tarifa_editada_tras_aprobacion" });
    expect(change.invalidatedApprovalIds).toHaveLength(1);
    expect(wf.getState()).toBe("en_revision");
    expect(wf.isFullyApproved()).toBe(false);

    const approvals = wf.listApprovals();
    expect(approvals[0].status).toBe("invalidada");
    expect(approvals[0].invalidatedReason).toBe("tarifa_editada_tras_aprobacion");
  });

  it("una nueva aprobación tras el cambio vuelve a dejar 'aprobado' el expediente", () => {
    const wf = new ApprovalWorkflow();
    wf.requestReview({ scopeRef: "expediente", actorId: "user-writer", actorRole: "writer" });
    wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: "hash-v1" });
    wf.recordChange({ scope: "seccion", scopeRef: "seccion:tecnica:experiencia", reason: "dato_editado" });
    expect(wf.isFullyApproved()).toBe(false);

    wf.requestReview({ scopeRef: "expediente", actorId: "user-writer-2", actorRole: "writer" });
    const reapproval = wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-admin", actorRole: "admin", inputsHash: "hash-v2" });
    expect(reapproval.ok).toBe(true);
    expect(wf.isFullyApproved()).toBe(true);
  });

  it("un cambio en una sección invalida también la aprobación de alcance expediente que la cubre (jerarquía de alcance)", () => {
    const wf = new ApprovalWorkflow();
    wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: "h" });
    const change = wf.recordChange({ scope: "seccion", scopeRef: "seccion:tecnica:experiencia", reason: "cambio_bases" });
    expect(change.invalidatedApprovalIds).toHaveLength(1);
    expect(wf.activeApprovalsCovering("expediente")).toHaveLength(0);
  });

  it("un cambio en una sección NO invalida una aprobación de una sección distinta e independiente", () => {
    const wf = new ApprovalWorkflow();
    wf.approve({ scope: "seccion", scopeRef: "seccion:tecnica:experiencia", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: "h" });
    wf.approve({ scope: "seccion", scopeRef: "seccion:tecnica:capacidad", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: "h2" });

    wf.recordChange({ scope: "seccion", scopeRef: "seccion:tecnica:experiencia", reason: "cambio" });

    expect(wf.activeApprovalsCovering("seccion:tecnica:experiencia")).toHaveLength(0);
    expect(wf.activeApprovalsCovering("seccion:tecnica:capacidad")).toHaveLength(1);
  });
});

describe("ApprovalWorkflow — EX-EXP-01: invalidación AUTOMÁTICA por hash de insumos divergente (REQ-162)", () => {
  beforeEach(() => resetApprovalCounters());

  it("revalidateAgainstCurrentHash invalida automáticamente una aprobación 'vigente' cuando el hash actual difiere, sin que nadie llame recordChange a mano", () => {
    const wf = new ApprovalWorkflow();
    wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: "hash-aprobado" });
    expect(wf.isFullyApproved()).toBe(true);

    const change = wf.revalidateAgainstCurrentHash({ scopeRef: "expediente", currentInputsHash: "hash-nuevo-tras-cambio-de-tarifa" });

    expect(change).not.toBeNull();
    expect(change!.invalidatedApprovalIds).toHaveLength(1);
    expect(wf.isFullyApproved()).toBe(false);
    expect(wf.listApprovals()[0].status).toBe("invalidada");
    expect(wf.listApprovals()[0].invalidatedReason).toContain("hash_insumos_divergente");
    expect(wf.listChanges()).toHaveLength(1);
  });

  it("revalidateAgainstCurrentHash no hace nada si el hash actual coincide con el aprobado", () => {
    const wf = new ApprovalWorkflow();
    wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: "hash-x" });

    const change = wf.revalidateAgainstCurrentHash({ scopeRef: "expediente", currentInputsHash: "hash-x" });

    expect(change).toBeNull();
    expect(wf.isFullyApproved()).toBe(true);
    expect(wf.listChanges()).toHaveLength(0);
  });

  it("isFullyApprovedForCurrentHash recalcula y refleja la invalidación automática en una sola llamada", () => {
    const wf = new ApprovalWorkflow();
    wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "user-reviewer", actorRole: "reviewer", inputsHash: "hash-v1" });

    expect(wf.isFullyApprovedForCurrentHash("hash-v1")).toBe(true);
    // La tarifa cambió: el hash recalculado ya no es el mismo.
    expect(wf.isFullyApprovedForCurrentHash("hash-v2-tarifa-cambiada")).toBe(false);
    expect(wf.listApprovals()[0].status).toBe("invalidada");
  });
});

describe("ApprovalWorkflow — comentarios y trazabilidad", () => {
  beforeEach(() => resetApprovalCounters());

  it("registra comentarios de cualquier rol con autor y momento", () => {
    const wf = new ApprovalWorkflow();
    const comment = wf.addComment({ scopeRef: "documento:tecnica", authorId: "user-legal", authorRole: "reviewer", text: "Falta evidencia de experiencia." });
    expect(comment.text).toContain("Falta evidencia");
    expect(wf.listComments("documento:tecnica")).toHaveLength(1);
  });
});
