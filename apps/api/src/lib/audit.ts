import type { DbExecutor } from '@atiende/db';

export interface AuditEntry {
  /**
   * `null` SOLO para eventos verdaderamente plataforma-wide sin
   * organización asociada (p.ej. reintentar un job de discovery, o
   * resolver un incidente sin org) -- API-10
   * (docs/auditoria-1/db-api-reverificacion.md): antes se OMITÍA por
   * completo la auditoría en ese caso, en vez de registrarla con
   * `org_id = null` (que `audit_log` ya soporta desde la migración 0035).
   */
  orgId: string | null;
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
