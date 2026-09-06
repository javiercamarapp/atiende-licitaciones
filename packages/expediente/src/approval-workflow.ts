/**
 * ApprovalWorkflow (REQ-159/REQ-161/REQ-162): estados borrador → en_revisión
 * → aprobado por rol (reviewer/admin/owner; nunca writer sobre lo propio,
 * nunca viewer). Cualquier edición o `ChangeDetected` invalida las
 * aprobaciones afectadas según su alcance (sección/documento/expediente) y
 * lo registra para auditoría.
 */
import { isoNow, type WorkflowRole } from "./types.js";
import { requireValidHashedInputs, type HashedInputs, type InputsHash } from "./proposal-version.js";

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
  /**
   * Hash de insumos BRANDED (EX-EXP-17): se almacena solo el `InputsHash`
   * (string branded), nunca el `ExpedienteInputs` completo — este objeto se
   * incluye tal cual en `PackageManifest.approvals` (serializado a JSON
   * dentro del ZIP), así que cargar los insumos completos aquí filtraría
   * datos de negocio y ablonaría el manifiesto innecesariamente.
   */
  inputsHash: InputsHash;
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
  approve(input: { scope: ApprovalScope; scopeRef: string; actorId: string; actorRole: WorkflowRole; inputsHash: HashedInputs }): WorkflowActionResult<Approval> {
    if (!APPROVER_ROLES.has(input.actorRole)) {
      return { ok: false, reason: `rol_no_autorizado_para_aprobar:${input.actorRole}` };
    }
    // EX-EXP-17: `inputsHash` DEBE ser un `HashedInputs` sellado por
    // `sealInputs`/`computeInputsHash` (o `ProposalVersionRegistry.
    // createVersion(...).hash`) — nunca un `string` calculado a mano. Lanza
    // `InvalidInputsHashError` (fail-closed) si no lo es, incluyendo el caso
    // de insumos mutados después de sellarse.
    const { hash: verifiedInputsHash } = requireValidHashedInputs(input.inputsHash, "Approval.inputsHash (approve())");
    // EX-EXP-02/EX-EXP-14 (reverificación ronda 1): `scope === "expediente"`
    // es la raíz jerárquica que cubre TODO el expediente — su `scopeRef`
    // DEBE ser exactamente la cadena `"expediente"`. Sin esta validación,
    // una aprobación mal construida (p. ej. un formulario de `apps/api` que
    // fija `scope` desde un desplegable independiente de un `scopeRef`
    // calculado dinámicamente) con `scope: "expediente"` pero
    // `scopeRef: "expediente-OTRO-EXPEDIENTE"` contaría igual como
    // aprobación TOTAL de un expediente distinto al que en realidad se
    // aprobó.
    if (input.scope === "expediente" && input.scopeRef !== "expediente") {
      return { ok: false, reason: `scope_scopeRef_inconsistente:scope="expediente"_exige_scopeRef="expediente",_recibido="${input.scopeRef}"` };
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
      inputsHash: verifiedInputsHash,
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

  /**
   * Revalida (REQ-162, invalidación AUTOMÁTICA — EX-EXP-01) si la aprobación
   * vigente de `scopeRef` sigue reflejando los insumos actuales: compara su
   * `inputsHash` registrado contra `currentInputsHash` (recién recalculado
   * por el llamador, p. ej. con `ProposalVersionRegistry.createVersion(...).hash`
   * sobre el estado actual de tarifas/documentos/datos de empresa/bases). Si
   * difiere, invalida automáticamente esa aprobación llamando a
   * `recordChange` internamente — deja el evento en `listChanges()` y el
   * `Approval.invalidatedReason` explícito — sin que nadie tenga que
   * acordarse de invocar `recordChange` a mano cuando cambia un insumo.
   *
   * Debe llamarse en cada evaluación de "¿sigue aprobado?" antes de
   * ensamblar el paquete (ver `isFullyApprovedForCurrentHash`); además,
   * `PackageAssembler.buildManifest` hace su propia verificación
   * independiente del hash, así que ni siquiera un llamador que omita esta
   * llamada puede producir un `"ready"` con insumos divergentes.
   */
  revalidateAgainstCurrentHash(input: { scopeRef: string; currentInputsHash: HashedInputs; reason?: string }): ChangeDetected | null {
    const { hash: currentHash } = requireValidHashedInputs(input.currentInputsHash, "revalidateAgainstCurrentHash(currentInputsHash)");
    const stale = this.approvals.filter(
      (a) => a.status === "vigente" && a.scopeRef === input.scopeRef && a.inputsHash !== currentHash,
    );
    if (stale.length === 0) return null;
    return this.recordChange({
      scope: stale[0].scope,
      scopeRef: input.scopeRef,
      reason: input.reason ?? `hash_insumos_divergente:aprobado=${stale[0].inputsHash}:actual=${currentHash}`,
    });
  }

  /**
   * Combina `revalidateAgainstCurrentHash` (alcance "expediente") con
   * `isFullyApproved()` en una sola llamada: recalcula automáticamente si
   * los insumos cubiertos por la aprobación de expediente cambiaron desde
   * que se aprobó y, si es así, la invalida antes de responder. Este es el
   * método que `apps/api` debe llamar en cada evaluación de "¿está listo?",
   * en vez de confiar en `isFullyApproved()` a secas (que no sabe nada del
   * hash actual de los insumos).
   */
  isFullyApprovedForCurrentHash(currentInputsHash: HashedInputs): boolean {
    this.revalidateAgainstCurrentHash({ scopeRef: "expediente", currentInputsHash });
    return this.isFullyApproved();
  }
}

/** Utilidad de solo pruebas: resetea contadores globales para IDs deterministas entre tests. */
export function resetApprovalCounters(): void {
  approvalCounter = 0;
  commentCounter = 0;
  changeCounter = 0;
}
