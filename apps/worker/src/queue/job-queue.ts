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
 * único dedicado — ver README §Pendientes y `apps/worker/db-proposals/`).
 * `enqueue()` serializa el SELECT-luego-INSERT de una misma clave con un
 * advisory lock transaccional (`pg_advisory_xact_lock`, ver WK-04 en
 * docs/auditoria-1/worker.md) para que dos procesos concurrentes nunca
 * dupliquen un job con el mismo `(kind, jobKey)`; el índice único parcial
 * sigue siendo la solución definitiva recomendada una vez que se apruebe
 * la migración propuesta.
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
    const maxAttempts = options.maxAttempts ?? 5;
    const runAt = options.runAt ?? (options.delayMs ? new Date(this.now().getTime() + options.delayMs) : this.now());

    if (options.jobKey) {
      const jobKey = options.jobKey;
      /**
       * WK-04 (docs/auditoria-1/worker.md): sin índice único
       * `(kind, payload->>'jobKey')` (no hay migración para eso en esta
       * ronda; propuesta en `apps/worker/db-proposals/`), un SELECT-luego-
       * INSERT plano en JS permite que dos procesos concurrentes (p. ej. dos
       * `Scheduler` de dos procesos `apps/worker`, el propio modo de
       * escalado horizontal que recomienda el README) vean "no existe
       * todavía" al mismo tiempo y ambos inserten, duplicando el job para la
       * misma fuente+ventana — confirmado 5/5 veces por la auditoría.
       *
       * Mitigación real sin migración de esquema: serializar el SELECT-
       * luego-INSERT de la MISMA clave con un advisory lock transaccional
       * (`pg_advisory_xact_lock(hashtext(kind||':'||jobKey))`), que SÍ es
       * atómico entre conexiones/procesos reales de Postgres (a diferencia
       * de una lectura en JS): un segundo proceso que intente la misma clave
       * mientras el primero sigue dentro de su transacción se BLOQUEA en el
       * `pg_advisory_xact_lock`, no puede seguir hasta que el primero haga
       * COMMIT/ROLLBACK (el lock se libera automáticamente ahí), momento en
       * el cual su propio SELECT ya verá la fila recién insertada. La
       * migración futura recomendada (índice único parcial, ver
       * `apps/worker/db-proposals/0025-jobs-dedupe-and-cancelled.sql`)
       * eliminaría la necesidad de este lock en cuanto se apruebe.
       */
      return this.db.transaction(async (tx) => {
        await tx.query('select pg_advisory_xact_lock(hashtext($1)::bigint)', [`${kind}:${jobKey}`]);

        const { rows: existing } = await tx.query<JobRow>(
          `select * from jobs
           where kind = $1 and payload ->> 'jobKey' = $2 and status in ('queued', 'running')
           order by created_at desc
           limit 1`,
          [kind, jobKey],
        );
        if (existing[0]) {
          return { job: mapJobRow(existing[0]), deduped: true };
        }

        const { rows } = await tx.query<JobRow>(
          `insert into jobs (org_id, kind, payload, max_attempts, next_run_at)
           values ($1, $2, $3::jsonb, $4, $5)
           returning *`,
          [options.orgId ?? null, kind, JSON.stringify(fullPayload), maxAttempts, runAt.toISOString()],
        );
        return { job: mapJobRow(rows[0]), deduped: false };
      });
    }

    const { rows } = await this.db.query<JobRow>(
      `insert into jobs (org_id, kind, payload, max_attempts, next_run_at)
       values ($1, $2, $3::jsonb, $4, $5)
       returning *`,
      [options.orgId ?? null, kind, JSON.stringify(fullPayload), maxAttempts, runAt.toISOString()],
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
   *
   * WK-01 (auditoría ronda 2, docs/auditoria-1/worker.md): la recuperación
   * de lease expirado (job `running` con `locked_at` vencido, típicamente un
   * proceso que murió por crash/OOM/SIGKILL a mitad del handler, que NUNCA
   * pasa por el `catch` de `Worker.process()` ni por tanto por `fail()`)
   * volvía a reclamar el job incrementando `attempts` sin comparar jamás
   * contra `max_attempts`: un job cuyo handler crashea repetidamente se
   * re-reclamaba para siempre, quedando `running` eternamente, nunca `dead`.
   * Ahora la MISMA sentencia UPDATE atómica decide, para la fila que ganó el
   * `FOR UPDATE SKIP LOCKED`: si el próximo intento (`attempts + 1`)
   * excedería `max_attempts`, la fila pasa directo a `dead` (con
   * `last_error` explícito) en vez de a `running` — sin importar si la causa
   * fue un fallo manejado (`fail()`) o un crash real recuperado por lease.
   * `claim()` retorna `undefined` para esa fila (nunca la entrega como
   * "reclamada" a un handler), igual que si no hubiera nada que reclamar.
   */
  async claim(workerId: string, options: { kinds?: string[]; leaseSeconds?: number } = {}): Promise<Job | undefined> {
    const leaseSeconds = options.leaseSeconds ?? 60;
    const now = this.now();
    const leaseCutoff = new Date(now.getTime() - leaseSeconds * 1000);
    const { rows } = await this.db.query<JobRow>(
      `update jobs
       set status = case when attempts + 1 > max_attempts then 'dead'::job_status else 'running'::job_status end,
           attempts = attempts + 1,
           locked_at = case when attempts + 1 > max_attempts then null else $2::timestamptz end,
           locked_by = case when attempts + 1 > max_attempts then null else $1 end,
           last_error = case
             when attempts + 1 > max_attempts
               then 'lease expirado tras ' || (attempts + 1)::text || ' intentos'
             else last_error
           end
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
    const row = rows[0];
    if (!row) return undefined;
    // La fila fue dead-letreada en vez de reclamada (attempts habría excedido
    // max_attempts): no se entrega como job "reclamado" a ningún worker.
    if (row.status === 'dead') return undefined;
    return mapJobRow(row);
  }

  /**
   * Refresca el lease de un job en curso; retorna `false` si ya no le
   * pertenece a `workerId` (otro worker lo reclamó, p. ej. tras una
   * recuperación de lease expirado con el worker original todavía vivo).
   *
   * WK-02 (fencing token, docs/auditoria-1/worker.md): no existe una
   * columna `lease_generation` dedicada (no se agregó migración nueva en
   * esta ronda, ver README §Pendientes/db-proposals), pero `attempts` YA
   * cumple ese rol: `claim()` la incrementa en CADA reclamo (inicial o por
   * recuperación de lease), así que su valor en el momento del `claim()` es,
   * de hecho, la generación/"fencing token" de esa posesión del lease. Si se
   * pasa `expectedAttempts` (el `job.attempts` devuelto por el `claim()` que
   * originó este handler) y la fila fue reclamada de nuevo por otro worker
   * mientras tanto, `attempts` ya cambió y esta condición también falla —
   * doble verificación (locked_by Y attempts) incluso en el caso extremo de
   * colisión de `workerId`.
   */
  async heartbeat(jobId: string, workerId: string, expectedAttempts?: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `update jobs
       set locked_at = $3
       where id = $1 and locked_by = $2 and status = 'running'
         and ($4::integer is null or attempts = $4::integer)`,
      [jobId, workerId, this.now().toISOString(), expectedAttempts ?? null],
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

  /**
   * WK-10 (docs/auditoria-1/worker.md): dead-letter INMEDIATO para errores
   * clasificados como permanentes (4xx salvo 429, validación de esquema,
   * fuente no configurada/no verificada — ver `queue/errors.ts`
   * `isPermanentJobError`). Reintentar un error permanente nunca cambia el
   * resultado (el dato/config no cambiará solo), así que gastar el ciclo
   * completo de backoff hasta `max_attempts` es puro desperdicio de
   * capacidad de worker. A diferencia de `fail()`, esto NO respeta
   * `max_attempts`/backoff: pasa a `dead` en el primer intento.
   */
  async deadLetterPermanent(job: Job, workerId: string, error: string): Promise<Job | undefined> {
    const { rows } = await this.db.query<JobRow>(
      `update jobs
       set status = 'dead', locked_at = null, locked_by = null, last_error = $3
       where id = $1 and locked_by = $2
       returning *`,
      [job.id, workerId, error],
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
