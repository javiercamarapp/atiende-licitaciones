import type { DbClient } from '@atiende/db';
import { computeBackoffDelayMs, type BackoffOptions } from './backoff.js';
import { type EnqueueOptions, type Job, type JobRow, mapJobRow } from './types.js';

export interface JobQueueOptions {
  db: DbClient;
  backoff?: BackoffOptions;
  now?: () => Date;
}

/**
 * Cola de trabajo sobre la tabla `jobs` (packages/db/migrations/0003_system_tables.sql).
 *
 * Reclamo atómico: `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)`
 * en una sola sentencia (mismo patrón validado en
 * packages/db/test/jobs-locking.test.ts). Además de `status = 'queued'`,
 * también reclama jobs `running` cuyo `locked_at` es más viejo que el lease
 * (`leaseSeconds`): esto es la recuperación de lease expirado, ya que la
 * tabla no tiene una columna `lease_until` dedicada (no se agregó una
 * migración nueva en esta ronda; ver README §Pendientes). El heartbeat
 * (`heartbeat()`) simplemente refresca `locked_at` mientras el job sigue
 * vivo, extendiendo el lease.
 *
 * Idempotencia por clave de job: `payload.jobKey` (no hay columna/índice
 * único dedicado — ver README §Pendientes). `enqueue()` hace
 * lectura-luego-inserción; documentado como no 100% atómico bajo Postgres
 * real con múltiples conexiones concurrentes (pendiente: índice único
 * parcial `(kind, payload->>'jobKey') WHERE status IN ('queued','running')`).
 */
export class JobQueue {
  private readonly db: DbClient;
  private readonly backoffOptions: BackoffOptions;
  private readonly now: () => Date;

  constructor(options: JobQueueOptions) {
    this.db = options.db;
    this.backoffOptions = options.backoff ?? {};
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(
    kind: string,
    payload: Record<string, unknown> = {},
    options: EnqueueOptions = {},
  ): Promise<{ job: Job; deduped: boolean }> {
    const fullPayload = options.jobKey ? { ...payload, jobKey: options.jobKey } : payload;

    if (options.jobKey) {
      const { rows } = await this.db.query<JobRow>(
        `select * from jobs
         where kind = $1 and payload ->> 'jobKey' = $2 and status in ('queued', 'running')
         order by created_at desc
         limit 1`,
        [kind, options.jobKey],
      );
      if (rows[0]) {
        return { job: mapJobRow(rows[0]), deduped: true };
      }
    }

    const runAt = options.runAt ?? (options.delayMs ? new Date(this.now().getTime() + options.delayMs) : this.now());
    const { rows } = await this.db.query<JobRow>(
      `insert into jobs (org_id, kind, payload, max_attempts, next_run_at)
       values ($1, $2, $3::jsonb, $4, $5)
       returning *`,
      [options.orgId ?? null, kind, JSON.stringify(fullPayload), options.maxAttempts ?? 5, runAt.toISOString()],
    );
    return { job: mapJobRow(rows[0]), deduped: false };
  }

  /**
   * Reclama como máximo un job. `kinds`, si se da, limita el reclamo a esos
   * tipos (útil para separar pools de workers por tipo de trabajo).
   *
   * IMPORTANTE: la comparación de tiempo usa `this.now()` (inyectable), NUNCA
   * `now()` de SQL. Si se usara `now()` de Postgres/PGlite, las pruebas con
   * `vi.useFakeTimers()`/`vi.setSystemTime()` no podrían controlar en
   * absoluto la recuperación de lease ni el backoff, porque el reloj del
   * motor de base de datos es independiente del reloj de JS que Vitest
   * intercepta. Con `this.now()` como única fuente de verdad, el mismo
   * `JobQueue` es determinista en pruebas y usa el reloj real en producción.
   */
  async claim(workerId: string, options: { kinds?: string[]; leaseSeconds?: number } = {}): Promise<Job | undefined> {
    const leaseSeconds = options.leaseSeconds ?? 60;
    const now = this.now();
    const leaseCutoff = new Date(now.getTime() - leaseSeconds * 1000);
    const { rows } = await this.db.query<JobRow>(
      `update jobs
       set status = 'running', locked_at = $2, locked_by = $1, attempts = attempts + 1
       where id = (
         select id from jobs
         where next_run_at <= $2
           and (
             status = 'queued'
             or (status = 'running' and locked_at < $3)
           )
           and ($4::text[] is null or kind = any($4::text[]))
         order by next_run_at
         for update skip locked
         limit 1
       )
       returning *`,
      [workerId, now.toISOString(), leaseCutoff.toISOString(), options.kinds ?? null],
    );
    return rows[0] ? mapJobRow(rows[0]) : undefined;
  }

  /** Refresca el lease de un job en curso; no hace nada (retorna `false`) si ya no le pertenece a `workerId`. */
  async heartbeat(jobId: string, workerId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `update jobs set locked_at = $3 where id = $1 and locked_by = $2 and status = 'running'`,
      [jobId, workerId, this.now().toISOString()],
    );
    return rowCount > 0;
  }

  async complete(jobId: string, workerId: string): Promise<Job | undefined> {
    const { rows } = await this.db.query<JobRow>(
      `update jobs
       set status = 'succeeded', locked_at = null, locked_by = null, last_error = null
       where id = $1 and locked_by = $2
       returning *`,
      [jobId, workerId],
    );
    return rows[0] ? mapJobRow(rows[0]) : undefined;
  }

  /**
   * Registra un fallo. Si `attempts >= maxAttempts`, el job pasa a `dead`
   * (dead letter) con el último error; si no, vuelve a `queued` con
   * `next_run_at` calculado por backoff exponencial + jitter.
   */
  async fail(job: Job, workerId: string, error: string): Promise<Job | undefined> {
    if (job.attempts >= job.maxAttempts) {
      const { rows } = await this.db.query<JobRow>(
        `update jobs
         set status = 'dead', locked_at = null, locked_by = null, last_error = $3
         where id = $1 and locked_by = $2
         returning *`,
        [job.id, workerId, error],
      );
      return rows[0] ? mapJobRow(rows[0]) : undefined;
    }

    const delayMs = computeBackoffDelayMs(job.attempts, this.backoffOptions);
    const nextRunAt = new Date(this.now().getTime() + delayMs);
    const { rows } = await this.db.query<JobRow>(
      `update jobs
       set status = 'queued', next_run_at = $3, last_error = $4, locked_at = null, locked_by = null
       where id = $1 and locked_by = $2
       returning *`,
      [job.id, workerId, nextRunAt.toISOString(), error],
    );
    return rows[0] ? mapJobRow(rows[0]) : undefined;
  }

  /** Cancela un job que aún no ha terminado. No hay estado `cancelled` en el enum (ver README §Pendientes): se usa `dead`. */
  async cancel(jobId: string, reason: string): Promise<Job | undefined> {
    const { rows } = await this.db.query<JobRow>(
      `update jobs
       set status = 'dead', last_error = $2, locked_at = null, locked_by = null
       where id = $1 and status in ('queued', 'running')
       returning *`,
      [jobId, `cancelado: ${reason}`],
    );
    return rows[0] ? mapJobRow(rows[0]) : undefined;
  }

  async getById(jobId: string): Promise<Job | undefined> {
    const { rows } = await this.db.query<JobRow>(`select * from jobs where id = $1`, [jobId]);
    return rows[0] ? mapJobRow(rows[0]) : undefined;
  }

  /** Libera el lock de un job sin cambiar su status ni contar como fallo (usado en cierre ordenado). */
  async release(jobId: string, workerId: string): Promise<void> {
    await this.db.query(
      `update jobs set locked_at = null, locked_by = null where id = $1 and locked_by = $2 and status = 'running'`,
      [jobId, workerId],
    );
  }

  /** Vuelve a poner en `queued` un job `running` propiedad de este worker, para que se reintente sin penalizar attempts (cierre ordenado). */
  async requeue(jobId: string, workerId: string): Promise<Job | undefined> {
    const { rows } = await this.db.query<JobRow>(
      `update jobs
       set status = 'queued', locked_at = null, locked_by = null
       where id = $1 and locked_by = $2 and status = 'running'
       returning *`,
      [jobId, workerId],
    );
    return rows[0] ? mapJobRow(rows[0]) : undefined;
  }
}
