import { describe, it, expect } from 'vitest';
import type { SourceId } from '@atiende/sources';
import { createMigratedDb } from '../test/helpers.js';
import { recordSourceRun, getLastSourceRun } from '../src/source-runs/source-runs-repository.js';

/**
 * WK-22 (docs/auditoria-1/worker-cierre.md, ALTA): activa el test que
 * acompañaba a `PROPOSAL-01-widen-source-run-status.sql` (WK-07). Antes de
 * esta ronda estaba `describe.skip` con cuerpos vacíos porque
 * `packages/db/migrations/0026_widen_source_run_status.sql` (que amplía el
 * enum real `source_run_status`) todavía no existía. Esa migración YA está
 * aplicada (confirmado: `createMigratedDb()` la incluye), pero
 * `toDbStatus()` (`src/source-runs/source-run-status.ts`) seguía
 * proyectando `rate_limited`/`not_configured`/`ingest_failed` -> `'failed'`
 * — "reparación declarada, código no actualizado" (la reverificación
 * ejecutó estos cuerpos reales y confirmó que fallaban). Ahora que
 * `toDbStatus()` se actualizó (mapeo 1:1), este test se activa de verdad
 * (sin `.skip`, ya no vacío) y pasa.
 */
describe('PROPOSAL-01 (WK-07/WK-22): source_run_status ampliado a 8 estados finos', () => {
  it('rate_limited y not_configured se persisten como su propio valor en status, no como failed', async () => {
    const db = await createMigratedDb();
    try {
      const sourceId: SourceId = 'dof';

      const rateLimited = await recordSourceRun(db, {
        sourceId,
        fineState: 'rate_limited',
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        finishedAt: new Date('2026-01-01T00:00:05.000Z'),
        attempts: 1,
      });
      expect(rateLimited.status).toBe('rate_limited');
      expect(rateLimited.evidence.fineState).toBe('rate_limited');

      // started_at posterior al de arriba, para que getLastSourceRun()
      // (order by started_at desc) devuelva esta corrida sin ambigüedad.
      const notConfigured = await recordSourceRun(db, {
        sourceId,
        fineState: 'not_configured',
        startedAt: new Date('2026-01-01T01:00:00.000Z'),
        finishedAt: new Date('2026-01-01T01:00:05.000Z'),
        attempts: 0,
      });
      expect(notConfigured.status).toBe('not_configured');
      expect(notConfigured.evidence.fineState).toBe('not_configured');

      // La última corrida registrada (getLastSourceRun) también expone el
      // valor real, no una proyección genérica a 'failed'.
      const last = await getLastSourceRun(db, sourceId);
      expect(last?.status).toBe('not_configured');
    } finally {
      await db.close();
    }
  });

  it('ingest_failed (WK-03) también se persiste con su propio valor, no como failed', async () => {
    const db = await createMigratedDb();
    try {
      const rows = await recordSourceRun(db, {
        sourceId: 'compras-mx',
        fineState: 'ingest_failed',
        startedAt: new Date(),
        finishedAt: new Date(),
        attempts: 1,
        evidence: { message: 'POST /internal/tenders/ingest -> 500' },
      });
      expect(rows.status).toBe('ingest_failed');
      expect(rows.evidence.fineState).toBe('ingest_failed');
      expect(rows.evidence.message).toBe('POST /internal/tenders/ingest -> 500');
    } finally {
      await db.close();
    }
  });
});
