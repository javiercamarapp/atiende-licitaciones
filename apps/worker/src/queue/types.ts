/**
 * Estados de `jobs.status` definidos en packages/db/migrations/0003_system_tables.sql.
 *
 * WK-12 (docs/auditoria-1/worker.md, higiene): `'failed'` existe en el enum
 * de la base de datos, pero ningún código de `apps/worker` lo asigna JAMÁS.
 * Es intencional, no un olvido: el diseño de reintentos de este worker solo
 * usa dos estados terminales/intermedios para un intento fallido —
 * `'queued'` (falló pero quedan reintentos, ver `JobQueue.fail()`) o
 * `'dead'` (falló y se agotaron los reintentos, o el error se clasificó como
 * permanente, ver `JobQueue.deadLetterPermanent()`/`isPermanentJobError`).
 * Un job "recién creado, nunca reclamado" y un job "que falló y está en
 * `next_run_at` esperando su próximo reintento" son, ambos, `'queued'`
 * — se distinguen mirando `attempts`/`last_error`, no `status`. `'failed'`
 * se mantiene en este tipo únicamente por paridad estructural con el enum
 * real de la base de datos (para que `JobRow.status`/`mapJobRow` tipen
 * correctamente cualquier fila que pudiera traerlo, p. ej. escrita por otro
 * proceso fuera de este worker), no porque este worker vaya a producirlo.
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';

export interface Job<Payload = Record<string, unknown>> {
  id: string;
  orgId: string | null;
  kind: string;
  payload: Payload;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextRunAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fila cruda tal como la regresa `pg`/PGlite (snake_case, tipos de driver). */
export interface JobRow {
  id: string;
  org_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_run_at: string | Date;
  locked_at: string | Date | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export function mapJobRow(row: JobRow): Job {
  return {
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    payload: row.payload ?? {},
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextRunAt: new Date(row.next_run_at),
    lockedAt: row.locked_at ? new Date(row.locked_at) : null,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Clave de idempotencia de un job, guardada dentro de `payload.jobKey`
 * (no existe columna dedicada: `packages/db` no se tocó en esta ronda, ver
 * README §Pendientes). `enqueue()` no encola un segundo job con el mismo
 * `(kind, jobKey)` mientras exista uno activo (`queued`/`running`).
 */
export interface EnqueueOptions {
  orgId?: string | null;
  jobKey?: string;
  maxAttempts?: number;
  delayMs?: number;
  runAt?: Date;
}

export interface JobHandlerContext {
  job: Job;
  /** Logger ya enlazado con `job_id`/`correlation_id` (ver `src/logger.ts`). */
  logger: import('../logger.js').Logger;
  signal: AbortSignal;
}

export type JobHandler<Payload = Record<string, unknown>> = (
  job: Job<Payload>,
  ctx: JobHandlerContext,
) => Promise<void>;
