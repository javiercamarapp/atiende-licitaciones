import type { DbExecutor } from '@atiende/db';

export interface AuditEntry {
  orgId: string;
  actorId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

/** Inserta una entrada de auditoría dentro de la misma transacción de la mutación. */
export async function recordAudit(tx: DbExecutor, entry: AuditEntry): Promise<void> {
  await tx.query(
    `insert into audit_log (org_id, actor_id, action, entity, entity_id, before, after, request_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      entry.orgId,
      entry.actorId,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      entry.before !== undefined ? JSON.stringify(entry.before) : null,
      entry.after !== undefined ? JSON.stringify(entry.after) : null,
      entry.requestId ?? null,
    ]
  );
}
