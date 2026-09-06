/**
 * Persistencia de `ApprovalWorkflow` (`@atiende/expediente`) sobre
 * `packages/db`. `ApprovalWorkflow` es una clase en memoria sin ninguna API
 * para "hidratar" un estado externo (contadores de id internos, mapa de
 * `submitters`, etc. son privados) -- y `packages/expediente` está fuera del
 * ámbito de este agente. La estrategia adoptada es reproducir, en orden, el
 * LOG de eventos persistido en `proposal_approval_events` sobre una
 * instancia NUEVA de `ApprovalWorkflow` en cada petición: el log es la
 * fuente de verdad; el estado en memoria resultante de la reproducción es
 * siempre equivalente al que existió en el momento de cada acción original
 * (mismos métodos, mismo orden, mismos argumentos).
 *
 * Concurrencia: `resetApprovalCounters()` resetea contadores GLOBALES de
 * `@atiende/expediente` (por proceso, no por instancia). Se llama
 * inmediatamente antes de reproducir el log y toda la reproducción +
 * mutación ocurre de forma SÍNCRONA (ningún `await` entre medio) dentro de
 * `withReplayedWorkflow`: Node.js es de un solo hilo y no interrumpe un
 * tramo síncrono, así que dos peticiones concurrentes (incluso de
 * propuestas distintas) nunca intercalan sus reproducciones. Los IDs
 * `approval-N`/`comment-N`/`change-N` que resultan de la reproducción son
 * artefactos internos de esa reproducción (nunca se usan como clave
 * primaria persistida); `proposal_approvals` guarda su propio `id` real
 * (uuid de Postgres) por fila materializada.
 */
import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '@atiende/db';
import type { OrgRole } from '@atiende/db';
import { ApprovalWorkflow, resetApprovalCounters, sealInputs, type ApprovalScope, type ExpedienteInputs, type HashedInputs, type WorkflowRole } from '@atiende/expediente';

interface EventRow {
  seq: string | number;
  kind: string;
  actor_id: string | null;
  actor_role: string;
  scope: string | null;
  scope_ref: string | null;
  inputs_hash: string | null;
  inputs_snapshot: unknown;
  text_body: string | null;
  reason: string | null;
  created_at: string | Date;
}

/** `WorkflowRole` de @atiende/expediente no incluye `analyst` (vocabulario de la librería, no del sistema); se mapea de forma explícita y documentada, igual que el resto de adaptadores de este proyecto (ver agent-stores.pg.ts). */
export function orgRoleToWorkflowRole(role: OrgRole): WorkflowRole {
  if (role === 'analyst') return 'writer'; // analyst no tiene equivalente propio en ApprovalWorkflow; se trata como escritor (nunca aprueba, igual que la intención real).
  return role;
}

export async function loadApprovalEvents(tx: DbExecutor, orgId: string, proposalId: string): Promise<EventRow[]> {
  const res = await tx.query<EventRow>(
    'select seq, kind, actor_id, actor_role, scope, scope_ref, inputs_hash, inputs_snapshot, text_body, reason, created_at from proposal_approval_events where org_id = $1 and proposal_id = $2 order by seq asc',
    [orgId, proposalId]
  );
  return res.rows;
}

/**
 * Reproduce el log de eventos sobre una instancia nueva de `ApprovalWorkflow`
 * y la devuelve (síncrono). Desde EX-EXP-17, un evento `approve` guarda el
 * `ExpedienteInputs` COMPLETO con el que se aprobó (`inputs_snapshot`, no
 * solo su hash) porque `sealInputs`/`requireValidHashedInputs` necesitan el
 * objeto completo para producir (o verificar) un `HashedInputs` válido: un
 * hash suelto ya no basta para "reconstruir" el sello. `sealInputs` vuelve
 * a calcular el hash de forma determinista sobre ese mismo snapshot, así
 * que el `HashedInputs` reproducido es idéntico al que se produjo la
 * primera vez.
 */
export function replayWorkflow(events: EventRow[]): ApprovalWorkflow {
  resetApprovalCounters();
  const workflow = new ApprovalWorkflow();
  for (const event of events) {
    const actorRole = event.actor_role as WorkflowRole;
    if (event.kind === 'request_review') {
      workflow.requestReview({ scopeRef: event.scope_ref ?? 'expediente', actorId: event.actor_id ?? 'desconocido', actorRole });
    } else if (event.kind === 'approve') {
      const snapshot = event.inputs_snapshot as ExpedienteInputs | null;
      if (!snapshot) continue; // evento corrupto/incompleto: se ignora en vez de reventar la reproducción completa (defensivo).
      workflow.approve({
        scope: (event.scope ?? 'expediente') as ApprovalScope,
        scopeRef: event.scope_ref ?? 'expediente',
        actorId: event.actor_id ?? 'desconocido',
        actorRole,
        inputsHash: sealInputs(snapshot),
      });
    } else if (event.kind === 'comment') {
      workflow.addComment({ scopeRef: event.scope_ref ?? 'expediente', authorId: event.actor_id ?? 'desconocido', authorRole: actorRole, text: event.text_body ?? '' });
    } else if (event.kind === 'record_change') {
      workflow.recordChange({ scope: (event.scope ?? 'expediente') as ApprovalScope, scopeRef: event.scope_ref ?? 'expediente', reason: event.reason ?? 'cambio_de_insumo' });
    }
  }
  return workflow;
}

/** Inserta un nuevo evento en el log (dentro de la transacción del llamador). */
export async function appendApprovalEvent(
  tx: DbExecutor,
  input: {
    orgId: string;
    proposalId: string;
    kind: 'request_review' | 'approve' | 'comment' | 'record_change';
    actorId: string | null;
    actorRole: OrgRole;
    scope?: ApprovalScope;
    scopeRef?: string;
    /** Solo para kind='approve' (EX-EXP-17): el `ExpedienteInputs` completo con el que se aprobó -- necesario para poder reproducir un `HashedInputs` válido al reproducir el log. */
    inputsSnapshot?: ExpedienteInputs | null;
    /** Hash en texto plano, solo para consulta/visualización rápida (nunca se reutiliza para volver a aprobar). */
    inputsHashForDisplay?: string | null;
    textBody?: string | null;
    reason?: string | null;
  }
): Promise<void> {
  await tx.query(
    `insert into proposal_approval_events (id, org_id, proposal_id, kind, actor_id, actor_role, scope, scope_ref, inputs_hash, inputs_snapshot, text_body, reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
    [
      randomUUID(),
      input.orgId,
      input.proposalId,
      input.kind,
      input.actorId,
      input.actorRole,
      input.scope ?? null,
      input.scopeRef ?? null,
      input.inputsHashForDisplay ?? null,
      input.inputsSnapshot ? JSON.stringify(input.inputsSnapshot) : null,
      input.textBody ?? null,
      input.reason ?? null,
    ]
  );
}

export type { HashedInputs };

/**
 * Rescribe el snapshot materializado `proposal_approvals` a partir del
 * estado ACTUAL de un `ApprovalWorkflow` reproducido (delete+insert
 * completo, dentro de la misma transacción) -- vista de lectura simple por
 * fila/RLS; el log de eventos sigue siendo la fuente de verdad.
 */
export async function persistApprovalSnapshot(tx: DbExecutor, orgId: string, proposalId: string, workflow: ApprovalWorkflow): Promise<void> {
  await tx.query('delete from proposal_approvals where org_id = $1 and proposal_id = $2', [orgId, proposalId]);
  for (const approval of workflow.listApprovals()) {
    await tx.query(
      `insert into proposal_approvals (id, org_id, proposal_id, approver_role, approver_id, status, decided_at, scope, scope_ref, inputs_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        orgId,
        proposalId,
        approval.approvedByRole,
        approval.approvedBy,
        approval.status === 'vigente' ? 'approved' : 'invalidated',
        approval.approvedAt,
        approval.scope,
        approval.scopeRef,
        approval.inputsHash,
      ]
    );
  }
}
