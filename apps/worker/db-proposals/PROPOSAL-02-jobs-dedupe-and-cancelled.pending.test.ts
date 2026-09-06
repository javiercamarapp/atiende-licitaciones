import { describe, it } from 'vitest';

/**
 * Test PENDIENTE (WK-04, docs/auditoria-1/worker.md): acompaña a
 * `PROPOSAL-02-jobs-dedupe-and-cancelled.sql`. El comportamiento FUNCIONAL
 * (0 duplicados bajo 2 schedulers concurrentes) ya está cubierto y en verde
 * HOY vía el advisory lock transaccional de `JobQueue.enqueue()` — ver
 * apps/worker/test/scheduler.test.ts ("dos Scheduler concurrentes... 20
 * iteraciones", con la nota de honestidad WK-15: eso demuestra la lógica
 * secuencial en PGlite, no concurrencia de motor real — pendiente contra
 * Postgres real, ref. B-03). Este test pendiente cubre, específicamente, la
 * garantía ESTRUCTURAL adicional que solo el índice único puede dar (y que
 * el advisory lock, por sí solo, no demuestra): que un segundo INSERT con la
 * misma `(kind, jobKey)` activa es rechazado por la base de datos incluso si
 * alguien más adelante escribe un `enqueue()` que se salte el advisory lock
 * por error.
 *
 * WK-15 (docs/auditoria-1/worker-reverificacion.md §5, riesgos de
 * PROPOSAL-02): el archivo `.sql` ahora documenta un "Paso 0" obligatorio de
 * detección+resolución de duplicados activos ANTES del `CREATE UNIQUE INDEX`
 * (puede fallar si ya existen), y aclara que ese `CREATE INDEX` NO usa
 * `CONCURRENTLY` (el runner de migraciones de `packages/db` lo ejecutaría
 * dentro de una transacción implícita, donde `CONCURRENTLY` no es válido) —
 * recomienda aplicarlo en una ventana de mantenimiento. El tercer caso de
 * este archivo (`PASO 0`) cubre esa detección específicamente.
 */
describe.skip('PENDIENTE esquema — WK-04/WK-15: índice único (kind, jobKey) activo', () => {
  it('un segundo INSERT directo (sin pasar por el advisory lock) con la misma (kind, jobKey) activa viola el índice único', () => {
    // Intencionalmente vacío. Habilitar tras aplicar
    // PROPOSAL-02-jobs-dedupe-and-cancelled.sql (incluido su "Paso 0" de
    // dedupe si aplica sobre una base con datos previos): insertar dos filas
    // `jobs` manualmente por SQL crudo con el mismo `kind`/
    // `payload->>'jobKey'` y `status = 'queued'` en ambas, y esperar que la
    // segunda inserción lance una violación de restricción única (23505).
  });

  it('cancel() usa el estado "cancelled" dedicado, distinguible de "dead" sin leer last_error', () => {
    // Intencionalmente vacío. Habilitar tras aplicar la migración Y
    // adaptar JobQueue.cancel() para usar status='cancelled' en vez de
    // 'dead' (ver comentario final del .sql).
  });

  it('PASO 0 (WK-15): la query de detección de duplicados activos devuelve 0 filas ANTES de aplicar el CREATE UNIQUE INDEX', () => {
    // Intencionalmente vacío. Habilitar ANTES de aplicar la migración en un
    // entorno con datos preexistentes (staging/producción, nunca en un
    // Postgres vacío de CI donde nunca puede haber duplicados): ejecutar la
    // query de detección documentada en el "PASO 0" del .sql
    // (`group by kind, payload ->> 'jobKey' having count(*) > 1` sobre
    // `status in ('queued','running')`) y confirmar 0 filas; si devuelve
    // filas, ejecutar la resolución documentada (conservar el más reciente,
    // marcar los demás `dead` con `last_error` explícito) y repetir la
    // query hasta 0 filas ANTES de continuar con el `CREATE UNIQUE INDEX`
    // (que de lo contrario fallaría — ver "Riesgo 1" del .sql).
  });
});
