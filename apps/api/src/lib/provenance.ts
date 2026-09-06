import type { DbExecutor } from '@atiende/db';

export type ProvenanceSource = 'manual' | 'import' | 'agent';

export interface ProvenanceEntry {
  orgId: string;
  entity: string;
  entityId: string;
  field: string;
  ownerUserId: string | null;
  source: ProvenanceSource;
}

/**
 * Registra procedencia por campo (REQ-142): quién lo capturó/confirmó
 * (`owner_user_id`), de dónde viene (`source`: manual/import/agent) y cuándo
 * (`updated_at`, vía trigger `app.set_updated_at`). Upsert por
 * `(org_id, entity, entity_id, field)`: la escritura más reciente de ese
 * campo reemplaza la procedencia anterior.
 *
 * Alcance de esta ronda: se registra procedencia por FILA (`field = '*'`)
 * para las tablas de perfil de empresa, no por columna individual dentro de
 * la fila. Cada fila de estas tablas (una capacidad, una referencia de
 * experiencia, un documento...) es en sí misma "un dato" del perfil en el
 * sentido de REQ-141/REQ-142; procedencia por columna individual dentro de
 * una fila (p.ej. solo el campo `unit_price` de una tarifa) queda fuera de
 * esta ronda y documentado como pendiente honesto en el README.
 */
export async function recordFieldProvenance(tx: DbExecutor, entry: ProvenanceEntry): Promise<void> {
  await tx.query(
    `insert into field_provenance (org_id, entity, entity_id, field, owner_user_id, source)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (org_id, entity, entity_id, field)
     do update set owner_user_id = excluded.owner_user_id, source = excluded.source, updated_at = now()`,
    [entry.orgId, entry.entity, entry.entityId, entry.field, entry.ownerUserId, entry.source]
  );
}

export async function deleteFieldProvenance(
  tx: DbExecutor,
  params: { orgId: string; entity: string; entityId: string }
): Promise<void> {
  await tx.query('delete from field_provenance where org_id = $1 and entity = $2 and entity_id = $3', [
    params.orgId,
    params.entity,
    params.entityId,
  ]);
}

export async function getFieldProvenance(
  tx: DbExecutor,
  params: { orgId: string; entity: string; entityId: string }
): Promise<Array<{ field: string; ownerUserId: string | null; source: string; updatedAt: string }>> {
  const { rows } = await tx.query<{ field: string; owner_user_id: string | null; source: string; updated_at: string }>(
    'select field, owner_user_id, source, updated_at from field_provenance where org_id = $1 and entity = $2 and entity_id = $3',
    [params.orgId, params.entity, params.entityId]
  );
  return rows.map((r) => ({ field: r.field, ownerUserId: r.owner_user_id, source: r.source, updatedAt: r.updated_at }));
}
