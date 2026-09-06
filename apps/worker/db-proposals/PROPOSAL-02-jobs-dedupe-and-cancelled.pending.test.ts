import { describe, it } from 'vitest';

/**
 * Test PENDIENTE (WK-04, docs/auditoria-1/worker.md): acompaña a
 * `PROPOSAL-02-jobs-dedupe-and-cancelled.sql`. El comportamiento FUNCIONAL
 * (0 duplicados bajo 2 schedulers concurrentes) ya está cubierto y en verde
 * HOY vía el advisory lock transaccional de `JobQueue.enqueue()` — ver
 * apps/worker/test/scheduler.test.ts ("dos Scheduler concurrentes... 20
 * iteraciones"). Este test pendiente cubre, específicamente, la garantía
 * ESTRUCTURAL adicional que solo el índice único puede dar (y que el
 * advisory lock, por sí solo, no demuestra): que un segundo INSERT con la
 * misma `(kind, jobKey)` activa es rechazado por la base de datos incluso si
 * alguien más adelante escribe un `enqueue()` que se salte el advisory lock
 * por error.
 */
describe.skip('PENDIENTE esquema — WK-04: índice único (kind, jobKey) activo', () => {
  it('un segundo INSERT directo (sin pasar por el advisory lock) con la misma (kind, jobKey) activa viola el índice único', () => {
    // Intencionalmente vacío. Habilitar tras aplicar
    // PROPOSAL-02-jobs-dedupe-and-cancelled.sql: insertar dos filas `jobs`
    // manualmente por SQL crudo con el mismo `kind`/`payload->>'jobKey'` y
    // `status = 'queued'` en ambas, y esperar que la segunda inserción
    // lance una violación de restricción única (23505).
  });

  it('cancel() usa el estado "cancelled" dedicado, distinguible de "dead" sin leer last_error', () => {
    // Intencionalmente vacío. Habilitar tras aplicar la migración Y
    // adaptar JobQueue.cancel() para usar status='cancelled' en vez de
    // 'dead' (ver comentario final del .sql).
  });
});
