import { describe, it } from 'vitest';

/**
 * Test PENDIENTE (WK-07, docs/auditoria-1/worker.md): acompaña a
 * `PROPOSAL-01-widen-source-run-status.sql`. NO se puede escribir en verde
 * hoy porque el enum `source_run_status` de packages/db todavía no tiene los
 * valores `rate_limited`/`not_configured`/`ingest_failed` (fuera de mi
 * ámbito tocar packages/db/migrations/). `it.skip` documenta la intención
 * exacta para que quien aplique la migración solo tenga que quitar el
 * `.skip` y ejecutar `createMigratedDb()` con la migración ya incluida.
 *
 * Una vez aplicada la migración propuesta, este test debería:
 *  1. Aplicar todas las migraciones (incluida la nueva) con
 *     `createMigratedDb()` (apps/worker/test/helpers.ts).
 *  2. Adaptar `toDbStatus()` según el comentario del .sql (mapeo 1:1 para
 *     `rate_limited`/`not_configured`).
 *  3. Llamar `recordSourceRun(db, { fineState: 'rate_limited', ... })` y
 *     `recordSourceRun(db, { fineState: 'not_configured', ... })`, y
 *     verificar `select status from source_runs where id = $1` devuelve
 *     EXACTAMENTE `'rate_limited'`/`'not_configured'` (no `'failed'`).
 */
describe.skip('PENDIENTE esquema — WK-07: source_run_status ampliado a 7+ estados', () => {
  it('rate_limited y not_configured se persisten como su propio valor en status, no como failed', () => {
    // Intencionalmente vacío: ver comentario de arriba y
    // PROPOSAL-01-widen-source-run-status.sql. Habilitar tras aplicar la
    // migración en packages/db.
  });
});
