-- 0027_jobs_dedupe_and_cancelled.sql
-- Incorpora PROPOSAL-02-jobs-dedupe-and-cancelled.sql (apps/worker/db-proposals/,
-- WK-04, docs/auditoria-1/worker.md).
--
-- El comportamiento funcional (0 duplicados bajo scheduling concurrente) ya
-- lo garantiza apps/worker con un `pg_advisory_xact_lock` transaccional en
-- `JobQueue.enqueue()` (ver apps/worker/test/scheduler.test.ts). Este índice
-- único es la defensa ESTRUCTURAL adicional: protege incluso si un futuro
-- `enqueue()` (o cualquier otro INSERT directo) se salta el advisory lock,
-- y permite simplificar `enqueue()` a `INSERT ... ON CONFLICT DO NOTHING`.
--
-- `'cancelled'` como estado propio: `JobQueue.cancel()` reutilizaba `dead`
-- con `last_error = 'cancelado: ...'`, indistinguible de un dead-letter por
-- reintentos agotados sin leer `last_error`.
alter type job_status add value if not exists 'cancelled';

-- Único parcial sobre (kind, payload->>'jobKey') mientras el job sigue
-- "vivo" (queued/running): una vez succeeded/dead/cancelled, la misma
-- clave puede reutilizarse para una ventana futura sin chocar con el
-- historial. No aplica a jobs sin `jobKey` en el payload (la mayoría de
-- jobs no declaran una clave de idempotencia explícita).
create unique index if not exists ux_jobs_kind_jobkey_active
  on jobs (kind, (payload ->> 'jobKey'))
  where payload ? 'jobKey' and status in ('queued', 'running');
