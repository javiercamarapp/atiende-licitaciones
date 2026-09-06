/**
 * ApprovalWorkflow (REQ-159/REQ-161/REQ-162): estados borrador → en_revisión
 * → aprobado por rol (reviewer/admin/owner; nunca writer sobre lo propio,
 * nunca viewer). Cualquier edición o `ChangeDetected` invalida las
 * aprobaciones afectadas según su alcance (sección/documento/expediente) y
 * lo registra para auditoría.
 */
import { isoNow, type WorkflowRole } from "./types.js";

export type ExpedienteState = "borrador" | "en_revision" | "aprobado";

export type ApprovalScope = "seccion" | "documento" | "expediente";

/** Roles que pueden aprobar. Ni `writer` ni `viewer` aparecen aquí — nunca aprueban, sin excepción. */
const APPROVER_ROLES: ReadonlySet<WorkflowRole> = new Set(["reviewer", "admin", "owner"]);
/** Roles que pueden enviar a revisión (deben haber escrito o ser dueños del expediente). */
const SUBMITTER_ROLES: ReadonlySet<WorkflowRole> = new Set(["writer", "owner", "admin"]);

export interface Approval {
  id: string;
  scope: ApprovalScope;
  /** Ruta jerárquica del alcance, p. ej. "expediente", "documento:tecnica", "seccion:tecnica:experiencia". */
  scopeRef: string;
  approvedBy: string;
  approvedByRole: WorkflowRole;
  approvedAt: string;
  inputsHash: string;
  status: "vigente" | "invalidada";
  invalidatedAt?: string;
  invalidatedReason?: string;
}

export interface Comment {
  id: string;
  scopeRef: string;
  authorId: string;
  authorRole: WorkflowRole;
  text: string;
  createdAt: string;
}

export interface ChangeDetected {
  id: string;
  scope: ApprovalScope;
  scopeRef: string;
  reason: string;
  detectedAt: string;
  invalidatedApprovalIds: string[];
}

export type WorkflowActionResult<T> = { ok: true; value: T } | { ok: false; reason: string };

let approvalCounter = 0;
let commentCounter = 0;
let changeCounter = 0;

/**
 * Alcances jerárquicos: "expediente" es la raíz y cubre todo; "documento:X"
 * cubre "seccion:X:Y" para cualquier sección Y de ese mismo documento X.
 * Formatos de `scopeRef` esperados: "expediente", "documento:<docId>",
 * "seccion:<docId>:<seccionId>". Devuelve, de más general a más específico,
 * todos los `scopeRef` de aprobación que cubrirían a `scopeRef`.
 */
function ancestorsOf(scopeRef: string): string[] {
  if (scopeRef === "expediente") return ["expediente"];
  const [kind, docId] = scopeRef.split(":");
  const ancestors = ["expediente"];
  if (kind === "seccion" && docId) ancestors.push(`documento:${docId}`);
  ancestors.push(scopeRef);
  return ancestors;
}

/** `true` si una aprobación con alcance `approvalScopeRef` cubre el alcance `targetScopeRef` (mismo alcance o un ancestro jerárquico). */
function isAncestorOrSame(approvalScopeRef: string, targetScopeRef: string): boolean {
  return ancestorsOf(targetScopeRef).includes(approvalScopeRef);
}

export class ApprovalWorkflow {
  private state: ExpedienteState = "borrador";
  private readonly submitters = new Map<string, string>(); // scopeRef -> actorId que envió a revisión
  private readonly approvals: Approval[] = [];
  private readonly comments: Comment[] = [];
  private readonly changes: ChangeDetected[] = [];

  getState(): ExpedienteState {
    return this.state;
  }

  requestReview(input: { scopeRef: string; actorId: string; actorRole: WorkflowRole }): WorkflowActionResult<void> {
    if (!SUBMITTER_ROLES.has(input.actorRole)) {
      return { ok: false, reason: `rol_no_autorizado_para_enviar_a_revision:${input.actorRole}` };
    }
    this.submitters.set(input.scopeRef, input.actorId);
    this.state = "en_revision";
    return { ok: true, value: undefined };
  }

  addComment(input: { scopeRef: string; authorId: string; authorRole: WorkflowRole; text: string }): Comment {
    const comment: Comment = {
      id: `comment-${++commentCounter}`,
      scopeRef: input.scopeRef,
      authorId: input.authorId,
      authorRole: input.authorRole,
      text: input.text,
      createdAt: isoNow(),
    };
    this.comments.push(comment);
    return comment;
  }

  listComments(scopeRef?: string): Comment[] {
    return scopeRef ? this.comments.filter((c) => c.scopeRef === scopeRef) : [...this.comments];
  }

  /**
   * Aprueba un alcance (sección/documento/expediente). Reglas duras:
   *  - solo roles reviewer/admin/owner pueden aprobar (REQ-159); writer y
   *    viewer siempre se rechazan aquí, sin excepción.
   *  - autoaprobación prohibida: quien envió ese alcance a revisión no
   *    puede aprobarlo, sin importar qué rol tenga ahora ("nunca writer
   *    sobre lo propio").
   */
  approve(input: { scope: ApprovalScope; scopeRef: string; actorId: string; actorRole: WorkflowRole; inputsHash: string }): WorkflowActionResult<Approval> {
    if (!APPROVER_ROLES.has(input.actorRole)) {
      return { ok: false, reason: `rol_no_autorizado_para_aprobar:${input.actorRole}` };
    }
    const submitter = this.submitters.get(input.scopeRef);
    if (submitter !== undefined && submitter === input.actorId) {
      return { ok: false, reason: "autoaprobacion_prohibida:mismo_actor_que_envio_a_revision" };
    }

    const approval: Approval = {
      id: `approval-${++approvalCounter}`,
      scope: input.scope,
      scopeRef: input.scopeRef,
      approvedBy: input.actorId,
      approvedByRole: input.actorRole,
      approvedAt: isoNow(),
      inputsHash: input.inputsHash,
      status: "vigente",
    };
    this.approvals.push(approval);
    if (input.scope === "expediente") this.state = "aprobado";
    return { ok: true, value: approval };
  }

  listApprovals(): Approval[] {
    return [...this.approvals];
  }

  /** Aprobaciones vigentes que cubren `scopeRef` (aprobación exacta o de un alcance ancestro, p. ej. expediente cubre todo). */
  activeApprovalsCovering(scopeRef: string): Approval[] {
    return this.approvals.filter((a) => a.status === "vigente" && isAncestorOrSame(a.scopeRef, scopeRef));
  }

  isFullyApproved(): boolean {
    return this.activeApprovalsCovering("expediente").length > 0;
  }

  /**
   * Registra un cambio detectado en un insumo ya aprobado (dato, documento,
   * tarifa, requisito, o cambio de bases/plazo) e invalida automáticamente
   * cualquier aprobación vigente cuyo alcance incluya `scopeRef` (la
   * aprobación exacta, o cualquier ancestro que la cubra: un cambio en una
   * sección invalida también la aprobación de todo el expediente).
   */
  recordChange(input: { scope: ApprovalScope; scopeRef: string; reason: string }): ChangeDetected {
    const affected = this.approvals.filter((a) => a.status === "vigente" && isAncestorOrSame(a.scopeRef, input.scopeRef));
    const timestamp = isoNow();
    for (const approval of affected) {
      approval.status = "invalidada";
      approval.invalidatedAt = timestamp;
      approval.invalidatedReason = input.reason;
    }
    if (affected.length > 0 && this.state === "aprobado") {
      this.state = "en_revision";
    }
    const change: ChangeDetected = {
      id: `change-${++changeCounter}`,
      scope: input.scope,
      scopeRef: input.scopeRef,
      reason: input.reason,
      detectedAt: timestamp,
      invalidatedApprovalIds: affected.map((a) => a.id),
    };
    this.changes.push(change);
    return change;
  }

  listChanges(): ChangeDetected[] {
    return [...this.changes];
  }
}

/** Utilidad de solo pruebas: resetea contadores globales para IDs deterministas entre tests. */
export function resetApprovalCounters(): void {
  approvalCounter = 0;
  commentCounter = 0;
  changeCounter = 0;
}
