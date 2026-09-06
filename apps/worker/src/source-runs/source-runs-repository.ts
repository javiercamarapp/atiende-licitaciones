import type { DbClient } from '@atiende/db';
import type { SourceId } from '@atiende/sources';
import { toDbStatus, type SourceRunFineState } from './source-run-status.js';

export interface RecordSourceRunInput {
  sourceId: SourceId;
  fineState: SourceRunFineState;
  startedAt: Date;
  finishedAt: Date;
  attempts: number;
  lastSuccessAt?: Date;
  /** Detalle de evidencia (REQ-147): httpStatus, hash de respuesta, mensaje. `fineState`/`message` siempre se incluyen. */
  evidence?: Record<string, unknown>;
  /** Cobertura esperado-vs-obtenido (REQ-147). */
  coverage?: Record<string, unknown>;
}

export interface SourceRunRow {
  id: string;
  source_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  attempts: number;
  last_success_at: string | null;
  evidence: Record<string, unknown>;
  coverage: Record<string, unknown>;
  created_at: string;
}

/**
 * Escribe una fila en `source_runs` (packages/db/migrations/0013_source_runs.sql).
 * Esta tabla es de PLATAFORMA (sin `org_id`, RLS "solo superadmin"): el
 * worker debe conectarse con un rol que pueda saltarse esa política (ver
 * README §Seguridad/Pendientes: hoy se usa la misma conexión "propietaria"
 * de las migraciones, igual que packages/db documenta para su propio
 * runner; un `worker_role` dedicado con solo los grants necesarios queda
 * como recomendación de endurecimiento, no implementable sin tocar
 * packages/db en esta ronda).
 */
export async function recordSourceRun(db: DbClient, input: RecordSourceRunInput): Promise<SourceRunRow> {
  const status = toDbStatus(input.fineState);
  const evidence = { fineState: input.fineState, ...input.evidence };
  const { rows } = await db.query<SourceRunRow>(
    `insert into source_runs (source_id, status, started_at, finished_at, attempts, last_success_at, evidence, coverage)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
     returning *`,
    [
      input.sourceId,
      status,
      input.startedAt.toISOString(),
      input.finishedAt.toISOString(),
      input.attempts,
      input.lastSuccessAt ? input.lastSuccessAt.toISOString() : null,
      JSON.stringify(evidence),
      JSON.stringify(input.coverage ?? {}),
    ],
  );
  return rows[0];
}

/** Última corrida registrada de una fuente (para frescura/último éxito), sin RLS de tenant (tabla de plataforma). */
export async function getLastSourceRun(db: DbClient, sourceId: SourceId): Promise<SourceRunRow | undefined> {
  const { rows } = await db.query<SourceRunRow>(
    `select * from source_runs where source_id = $1 order by started_at desc limit 1`,
    [sourceId],
  );
  return rows[0];
}
