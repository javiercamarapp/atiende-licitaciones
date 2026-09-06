-- PROPOSAL-02-jobs-dedupe-and-cancelled.sql
-- PENDIENTE esquema (WK-04, docs/auditoria-1/worker.md).
--
-- Propuesta de apps/worker para quien mantiene packages/db. Fuera de mi
-- ámbito: NO se aplicó, NO se añadió a packages/db/migrations/. El número
-- final de archivo real lo asigna quien la incorpore, coordinado con
-- cualquier migración concurrente.
--
-- Mitigación YA aplicada en este mismo ámbito (apps/worker), sin tocar
-- packages/db: `JobQueue.enqueue()` (apps/worker/src/queue/job-queue.ts)
-- ahora serializa el SELECT-luego-INSERT de una misma `(kind, jobKey)` con
-- `pg_advisory_xact_lock` dentro de una transacción, verificado con un test
-- de 2 `Scheduler` concurrentes x 20 iteraciones sin duplicados
-- (apps/worker/test/scheduler.test.ts). Esa mitigación es correcta y
-- suficiente para Postgres real, pero un índice único es la defensa
-- estructural definitiva (más barata de razonar, protege incluso contra un
-- futuro `enqueue()` que se le olvide tomar el advisory lock) y permite
-- simplificar `enqueue()` a un `INSERT ... ON CONFLICT DO NOTHING`.
--
-- También incluye `'cancelled'` en el enum `job_status`: hoy `JobQueue.cancel()`
-- (apps/worker/src/queue/job-queue.ts) reusa `dead` con
-- `last_error = 'cancelado: <motivo>'`, indistinguible de un dead-letter por
-- reintentos agotados si alguien mira solo `status` sin leer `last_error`.

alter type job_status add value if not exists 'cancelled';

-- Índice único parcial sobre la clave de idempotencia real (kind + jobKey
-- dentro de payload), solo mientras el job sigue "vivo" (queued/running):
-- una vez succeeded/dead/cancelled, la misma clave puede volver a usarse
-- para una ventana futura sin chocar con el historial.
create unique index if not exists ux_jobs_kind_jobkey_active
  on jobs (kind, (payload ->> 'jobKey'))
  where payload ? 'jobKey' and status in ('queued', 'running');

-- Adaptación de compatibilidad recomendada para
-- apps/worker/src/queue/job-queue.ts UNA VEZ aplicada esta migración:
--
--   async enqueue(kind, payload, options) {
--     ...
--     if (options.jobKey) {
--       try {
--         const { rows } = await this.db.query(
--           `insert into jobs (org_id, kind, payload, max_attempts, next_run_at)
--            values ($1, $2, $3::jsonb, $4, $5)
--            on conflict (kind, (payload ->> 'jobKey'))
--              where payload ? 'jobKey' and status in ('queued', 'running')
--            do nothing
--            returning *`,
--           [...],
--         );
--         if (rows[0]) return { job: mapJobRow(rows[0]), deduped: false };
--         // conflicto: leer la fila activa existente (SELECT normal, ya sin
--         // ninguna condición de carrera posible gracias al índice único).
--         const existing = await this.db.query(`select * from jobs where kind = $1 and payload ->> 'jobKey' = $2 and status in ('queued','running') limit 1`, [kind, options.jobKey]);
--         return { job: mapJobRow(existing.rows[0]), deduped: true };
--       } catch (...) { ... }
--     }
--     ...
--   }
--
-- Y `JobQueue.cancel()` puede pasar a `status = 'cancelled'` en vez de
-- `'dead'`, simplificando la lectura de `docs/logs`/back office sin
-- necesidad de parsear `last_error`. El advisory lock transaccional puede
-- eliminarse una vez el índice esté en producción (o dejarse como defensa
-- en profundidad adicional, sin costo real: `pg_advisory_xact_lock` sobre
-- una clave que ya nunca colisiona por el índice es prácticamente gratis).
