import { ZodError } from 'zod';

/**
 * WK-10 (docs/auditoria-1/worker.md): clasificación de errores permanentes
 * vs. transitorios. Un error PERMANENTE (fuente no configurada/no
 * verificada, un 4xx de `apps/api` salvo 429, un dato que no pasa
 * validación zod) no cambia de resultado por reintentar — el dato/config
 * seguirá siendo el mismo la próxima vez — así que `Worker.process()` debe
 * dead-letrar inmediatamente (`JobQueue.deadLetterPermanent`) en vez de
 * gastar el ciclo completo de backoff hasta `max_attempts`.
 *
 * Detección por "duck typing" (`error.permanent === true`) en vez de
 * `instanceof` para evitar que `apps/worker/src/queue/*` (capa genérica de
 * cola) tenga que importar tipos de `handlers/*`/`ingest/*` (capas
 * específicas de dominio) — cualquier error de cualquier handler puede
 * marcarse permanente simplemente exponiendo esa propiedad de solo lectura.
 */
export interface PermanentErrorMarker {
  readonly permanent: true;
}

export function isPermanentJobError(error: unknown): boolean {
  if (error instanceof ZodError) return true;
  if (error && typeof error === 'object' && (error as { permanent?: unknown }).permanent === true) {
    return true;
  }
  return false;
}

/**
 * WK-14 (docs/auditoria-1/worker-reverificacion.md, cierre de WK-02
 * PARCIAL): lanzado por `JobQueue.heartbeat()` (no — ese sigue devolviendo
 * `boolean`, ver más abajo)/`complete()`/`fail()`/`deadLetterPermanent()`
 * cuando el `lockedBy` provisto (el token de lease COMPLETO devuelto por
 * `claim()`, no solo el `workerId`) ya no coincide con la fila real —
 * porque otro `claim()` (de CUALQUIER worker, incluido el mismo `workerId`
 * reutilizado tras un reinicio) ya tomó posesión del job. Antes de esta
 * ronda, `complete()`/`fail()`/`deadLetterPermanent()` solo comparaban
 * `locked_by = workerId`: si el mismo proceso se reiniciaba con el MISMO
 * `WORKER_ID` (patrón explícitamente sugerido por el README, ver
 * `apps/worker/README.md`), un handler "zombie" de la generación ANTERIOR
 * podía terminar el job de la generación NUEVA sin que nadie lo detectara
 * (`locked_by` volvía a coincidir con el mismo string). Ahora `claim()`
 * genera un lease token nuevo (UUID) en CADA reclamo — incluso si el
 * `workerId` es idéntico al de la generación anterior — y lo embebe en
 * `locked_by` como `${workerId}::${uuid}` (sin migración de esquema nueva,
 * ver README §Pendientes); las 4 operaciones exigen el `locked_by` EXACTO
 * (no solo el prefijo `workerId`) antes de tocar cualquier fila, y lanzan
 * `StaleLeaseError` — SIN persistir ningún cambio — si no coincide.
 */
export class StaleLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleLeaseError';
  }
}
