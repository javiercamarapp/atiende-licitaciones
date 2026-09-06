import { createHash } from 'node:crypto';
import type { DbExecutor } from '@atiende/db';
import { IdempotencyConflictError } from './errors.js';

export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export interface IdempotentResult<T> {
  statusCode: number;
  body: T;
  replayed: boolean;
}

/**
 * Envoltura de idempotencia para mutaciones POST con contexto de
 * organización. Semántica (ver docs/AGENTES/README):
 *  - Sin header Idempotency-Key: `fn` se ejecuta normalmente, sin registro.
 *  - Con header + misma clave + mismo cuerpo (hash): se reproduce la
 *    respuesta original guardada, sin ejecutar `fn` de nuevo.
 *  - Con header + misma clave + cuerpo DISTINTO: 422 (IdempotencyConflictError).
 *
 * Alcance de ronda 1: solo se usa en endpoints que ya tienen org_id resuelto
 * (idempotency_keys.org_id es NOT NULL). Rutas sin organización (registro,
 * creación de organización) quedan fuera de este mecanismo por ahora — ver
 * limitación documentada en apps/api/README.md.
 */
export async function runIdempotent<T>(
  tx: DbExecutor,
  params: { orgId: string; key: string; requestHash: string },
  fn: () => Promise<{ statusCode: number; body: T }>
): Promise<IdempotentResult<T>> {
  const existing = await tx.query<{ request_hash: string; response: T; status_code: number; status: string }>(
    'select request_hash, response, status_code, status from idempotency_keys where org_id = $1 and key = $2',
    [params.orgId, params.key]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.request_hash !== params.requestHash) {
      throw new IdempotencyConflictError();
    }
    if (row.status === 'completed') {
      return { statusCode: row.status_code, body: row.response, replayed: true };
    }
  }

  const result = await fn();

  await tx.query(
    `insert into idempotency_keys (org_id, key, request_hash, response, status_code, status, expires_at)
     values ($1, $2, $3, $4::jsonb, $5, 'completed', now() + interval '1 day')
     on conflict (org_id, key)
     do update set response = excluded.response, status_code = excluded.status_code, status = 'completed', updated_at = now()`,
    [params.orgId, params.key, params.requestHash, JSON.stringify(result.body), result.statusCode]
  );

  return { ...result, replayed: false };
}
