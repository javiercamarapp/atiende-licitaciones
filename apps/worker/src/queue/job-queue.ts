import { randomUUID } from 'node:crypto';
import type { DbClient } from '@atiende/db';
import { computeBackoffDelayMs, type BackoffOptions } from './backoff.js';
import { StaleLeaseError } from './errors.js';
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
 *
 * WK-15 (docs/auditoria-1/worker-reverificacion.md, cierre de WK-04
 * PARCIAL): el SQL de arriba es correcto para Postgres real; en PGlite
 * (una sola conexión/proceso, sin concurrencia de motor real posible) solo
 * se verifica la lógica secuencial (`test/scheduler.test.ts` "WK-04") y,
 * por separado, el SQL exacto emitido — `pg_advisory_xact_lock` con la
 * clave estable `${kind}:${jobKey}` (`test/scheduler.test.ts` "WK-15"). La
 * concurrencia de motor real contra Postgres queda PENDIENTE (ref. B-03,
 * README §Pendientes).
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
    // WK-14 (docs/auditoria-1/worker-reverificacion.md): lease token REAL,
    // generado en CADA reclamo (inicial o por recuperación de lease
    // expirado), sin importar si `workerId` es igual o distinto al de la
    // generación anterior — un reinicio con el MISMO `WORKER_ID` (patrón
    // sugerido por el README) produce igualmente un `locked_by` NUEVO,
    // porque el UUID es aleatorio por llamada. Se embebe en `locked_by`
    // (columna ya existente, sin migración nueva) como `${workerId}::${uuid}`;
    // `heartbeat()`/`complete()`/`fail()`/`deadLetterPermanent()` exigen
    // esta cadena COMPLETA, no solo el prefijo `workerId`.
    const lockedByValue = `${workerId}::${randomUUID()}`;
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
      [lockedByValue, now.toISOString(), leaseCutoff.toISOString(), options.kinds ?? null],
    );
    const row = rows[0];
    if (!row) return undefined;
    // La fila fue dead-letreada en vez de reclamada (attempts habría excedido
    // max_attempts): no se entrega como job "reclamado" a ningún worker.
    if (row.status === 'dead') return undefined;
    return mapJobRow(row);
  }

  /**
   * Refresca el lease de un job en curso; retorna `false` si `lockedBy` ya
   * no coincide EXACTO con la fila (otro `claim()` — de cualquier worker,
   * incluido el mismo `workerId` reutilizado tras un reinicio — se lo llevó
   * mientras tanto).
   *
   * WK-14 (docs/auditoria-1/worker-reverificacion.md, reemplaza el fencing
   * por `attempts` de WK-02): `lockedBy` debe ser el valor EXACTO devuelto
   * por `claim()` (`Job.lockedBy`, con el lease token UUID embebido), no
   * solo el `workerId`. A diferencia de `complete()`/`fail()`/
   * `deadLetterPermanent()`, `heartbeat()` sigue devolviendo `boolean` (no
   * lanza `StaleLeaseError`): se sondea periódicamente en un `setInterval`
   * de "fire and forget" (`Worker.process()`) precisamente para detectar la
   * pérdida de lease ANTES de que el handler termine, no para abortar la
   * propia operación de heartbeat.
   */
  async heartbeat(jobId: string, lockedBy: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `update jobs
       set locked_at = $3
       where id = $1 and locked_by = $2 and status = 'running'`,
      [jobId, lockedBy, this.now().toISOString()],
    );
    return rowCount > 0;
  }

  /**
   * WK-14: `lockedBy` debe ser el valor EXACTO devuelto por `claim()`
   * (`Job.lockedBy`). Si no coincide con la fila (`status='running' AND
   * locked_by=lockedBy`), NO se persiste ningún cambio y se lanza
   * `StaleLeaseError` — nunca un no-op silencioso — para que quien llama
   * (`Worker.process()`) pueda distinguir "de verdad completé este job" de
   * "mi lease ya no era válido cuando intenté completar".
   */
  async complete(jobId: string, lockedBy: string): Promise<Job> {
    const { rows } = await this.db.query<JobRow>(
      `update jobs
       set status = 'succeeded', locked_at = null, locked_by = null, last_error = null
       where id = $1 and locked_by = $2 and status = 'running'
       returning *`,
      [jobId, lockedBy],
    );
    if (!rows[0]) {
      throw new StaleLeaseError(
        `complete(): lease inválido o vencido para el job ${jobId} (lockedBy no coincide con la fila real, o ya no está "running"); ningún cambio se persistió (WK-14).`,
      );
    }
    return mapJobRow(rows[0]);
  }

  /**
   * Registra un fallo. Si `attempts >= maxAttempts`, el job pasa a `dead`
   * (dead letter) con el último error; si no, vuelve a `queued` con
   * `next_run_at` calculado por backoff exponencial + jitter.
   *
   * WK-14: mismo contrato de `lockedBy` exacto + `StaleLeaseError` que
   * `complete()`/`deadLetterPermanent()` — ver esa nota.
   */
  async fail(job: Job, lockedBy: string, error: string): Promise<Job> {
    if (job.attempts >= job.maxAttempts) {
      const { rows } = await this.db.query<JobRow>(
        `update jobs
         set status = 'dead', locked_at = null, locked_by = null, last_error = $3
         where id = $1 and locked_by = $2 and status = 'running'
         returning *`,
        [job.id, lockedBy, error],
      );
      if (!rows[0]) {
        throw new StaleLeaseError(
          `fail() (dead-letter por max_attempts): lease inválido o vencido para el job ${job.id}; ningún cambio se persistió (WK-14).`,
        );
      }
      return mapJobRow(rows[0]);
    }

    const delayMs = computeBackoffDelayMs(job.attempts, this.backoffOptions);
    const nextRunAt = new Date(this.now().getTime() + delayMs);
    const { rows } = await this.db.query<JobRow>(
      `update jobs
       set status = 'queued', next_run_at = $3, last_error = $4, locked_at = null, locked_by = null
       where id = $1 and locked_by = $2 and status = 'running'
       returning *`,
      [job.id, lockedBy, nextRunAt.toISOString(), error],
    );
    if (!rows[0]) {
      throw new StaleLeaseError(
        `fail(): lease inválido o vencido para el job ${job.id}; ningún cambio se persistió (WK-14).`,
      );
    }
    return mapJobRow(rows[0]);
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
   *
   * WK-14: mismo contrato de `lockedBy` exacto + `StaleLeaseError` que
   * `complete()`/`fail()` — ver esa nota.
   */
  async deadLetterPermanent(job: Job, lockedBy: string, error: string): Promise<Job> {
    const { rows } = await this.db.query<JobRow>(
      `update jobs
       set status = 'dead', locked_at = null, locked_by = null, last_error = $3
       where id = $1 and locked_by = $2 and status = 'running'
       returning *`,
      [job.id, lockedBy, error],
    );
    if (!rows[0]) {
      throw new StaleLeaseError(
        `deadLetterPermanent(): lease inválido o vencido para el job ${job.id}; ningún cambio se persistió (WK-14).`,
      );
    }
    return mapJobRow(rows[0]);
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

  /**
   * Libera el lock de un job sin cambiar su status ni contar como fallo
   * (usado en cierre ordenado). `lockedBy` debe ser el valor EXACTO de
   * `Job.lockedBy` (WK-14): sin fila que coincida, es un no-op silencioso
   * (a propósito — liberar un lock que ya no es tuyo no debe romper el
   * apagado ordenado con una excepción).
   */
  async release(jobId: string, lockedBy: string): Promise<void> {
    await this.db.query(
      `update jobs set locked_at = null, locked_by = null where id = $1 and locked_by = $2 and status = 'running'`,
      [jobId, lockedBy],
    );
  }

  /**
   * Vuelve a poner en `queued` un job `running` propiedad de este worker,
   * para que se reintente sin penalizar attempts (cierre ordenado).
   * `lockedBy` debe ser el valor EXACTO de `Job.lockedBy` (WK-14).
   */
  async requeue(jobId: string, lockedBy: string): Promise<Job | undefined> {
    const { rows } = await this.db.query<JobRow>(
      `update jobs
       set status = 'queued', locked_at = null, locked_by = null
       where id = $1 and locked_by = $2 and status = 'running'
       returning *`,
      [jobId, lockedBy],
    );
    return rows[0] ? mapJobRow(rows[0]) : undefined;
  }
}
