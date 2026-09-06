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
