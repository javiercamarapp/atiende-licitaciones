import { describe, it, expect } from 'vitest';
import { createMigratedDb } from '../test/helpers.js';
import { JobQueue } from '../src/queue/job-queue.js';

/**
 * WK-22 (docs/auditoria-1/worker-cierre.md, ALTA): activa los tests que
 * acompañaban a `PROPOSAL-02-jobs-dedupe-and-cancelled.sql` (WK-04/WK-15).
 * `packages/db/migrations/0027_jobs_dedupe_and_cancelled.sql` (índice único
 * + valor `'cancelled'` del enum) y `0026b_resolve_duplicate_active_jobs.sql`
 * (Paso 0, dedupe preexistente) ya están aplicadas. El índice único ya
 * protegía de verdad (confirmado por la reverificación); lo único que
 * faltaba era que `JobQueue.cancel()` usara `'cancelled'` en vez de
 * `'dead'` — ya corregido (ver `src/queue/job-queue.ts`).
 */
describe('PROPOSAL-02 (WK-04/WK-15/WK-22): índice único (kind, jobKey) activo + cancelled', () => {
  it('un segundo INSERT directo (sin pasar por el advisory lock) con la misma (kind, jobKey) activa viola el índice único', async () => {
    const db = await createMigratedDb();
    try {
      await db.query(
        "insert into jobs (kind, payload, status) values ('discover_tenders', '{\"jobKey\": \"proposal-02-dup\"}'::jsonb, 'queued')",
      );
      await expect(
        db.query(
          "insert into jobs (kind, payload, status) values ('discover_tenders', '{\"jobKey\": \"proposal-02-dup\"}'::jsonb, 'queued')",
        ),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('cancel() usa el estado "cancelled" dedicado, distinguible de "dead" sin leer last_error', async () => {
    const db = await createMigratedDb();
    try {
      const queue = new JobQueue({ db });
      const { job } = await queue.enqueue('discover_tenders', {});
      const cancelled = await queue.cancel(job.id, 'ya no se necesita (PROPOSAL-02)');
      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.status).not.toBe('dead');

      const { rows } = await db.query<{ status: string }>('select status from jobs where id = $1', [job.id]);
      expect(rows[0].status).toBe('cancelled');
    } finally {
      await db.close();
    }
  });

  it('PASO 0 (WK-15): la query de detección de duplicados activos devuelve 0 filas en una base recién migrada', async () => {
    const db = await createMigratedDb();
    try {
      // Misma query de detección documentada en el "PASO 0" de
      // 0026b_resolve_duplicate_active_jobs.sql: en una base recién
      // migrada (sin datos preexistentes, como cualquier entorno de CI)
      // nunca puede haber duplicados activos, así que debe devolver 0 filas.
      const { rows } = await db.query<{ kind: string; job_key: string; total: number }>(
        `select kind, payload ->> 'jobKey' as job_key, count(*) as total
         from jobs
         where payload ? 'jobKey' and status in ('queued', 'running')
         group by kind, payload ->> 'jobKey'
         having count(*) > 1`,
      );
      expect(rows).toHaveLength(0);

      // La función de resolución reutilizable (0026b) también reporta 0
      // filas resueltas contra una base sin duplicados.
      const { rows: resolvedRows } = await db.query<{ resolve_duplicate_active_jobs: number }>(
        'select app.resolve_duplicate_active_jobs()',
      );
      expect(resolvedRows[0].resolve_duplicate_active_jobs).toBe(0);
    } finally {
      await db.close();
    }
  });
});
