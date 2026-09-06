/**
 * Estado explícito de una corrida de fuente, con la granularidad exacta
 * pedida en esta ronda (REQ-148/AMPLIACION-BACKOFFICE §2): activa, caída,
 * CAPTCHA, cambio de interfaz, permisos/autenticación faltante,
 * rate-limited y "no configurada" (fuente sin credenciales/URL real, o sin
 * verificación puntual documentada — REQ-150).
 *
 * WK-22 (docs/auditoria-1/worker-cierre.md, ALTA): `packages/db/migrations/
 * 0026_widen_source_run_status.sql` YA amplió el enum real `source_run_status`
 * con `rate_limited`/`not_configured`/`ingest_failed` (aplicado, confirmado
 * por `pg_enum`), pero esta función seguía proyectando esos 3 estados a
 * `'failed'` — "reparación declarada, código no actualizado". Ahora los 3
 * se persisten con su propio valor 1:1 en la columna real `status`. El
 * estado fino sigue guardándose TAMBIÉN en `evidence.fineState`/
 * `evidence.message` (columna `jsonb`) por compatibilidad de lectura hacia
 * atrás (cualquier consumidor que ya lea `evidence.fineState` en vez de
 * `status` sigue funcionando igual), no porque la columna `status` ya no
 * sea la fuente de verdad — ahora SÍ lo es para los 8 estados finos.
 */
export type SourceRunFineState =
  | 'ok'
  | 'down'
  | 'captcha_detected'
  | 'interface_changed'
  | 'permission_missing'
  | 'rate_limited'
  | 'not_configured'
  /**
   * WK-03 (docs/auditoria-1/worker.md): el `discover()` del conector tuvo
   * éxito (los `TenderRecord` se extrajeron correctamente) pero el envío
   * posterior a `apps/api` (`TenderIngestClient.ingest()`) falló — un
   * problema DISTINTO de que la fuente esté caída/con CAPTCHA/etc. Antes de
   * esta ronda esta rama ni siquiera escribía una fila en `source_runs`
   * (violaba el contrato "SIEMPRE registra, incluso si falla"); ahora
   * `discover-tenders.ts` la registra explícitamente con este estado fino.
   */
  | 'ingest_failed';

/**
 * Estado de la columna real `source_runs.status` (packages/db). WK-22:
 * ampliado 1:1 con los 3 valores agregados por
 * `packages/db/migrations/0026_widen_source_run_status.sql` — ya no hay
 * ningún `SourceRunFineState` sin equivalente exacto en la columna real.
 */
export type SourceRunDbStatus =
  | 'ok'
  | 'failed'
  | 'captcha'
  | 'interface_changed'
  | 'permission_missing'
  | 'down'
  | 'rate_limited'
  | 'not_configured'
  | 'ingest_failed';

const FINE_TO_DB: Record<SourceRunFineState, SourceRunDbStatus> = {
  ok: 'ok',
  down: 'down',
  captcha_detected: 'captcha',
  interface_changed: 'interface_changed',
  permission_missing: 'permission_missing',
  // WK-22: mapeo 1:1 ahora que el enum real de la base los soporta
  // (antes se proyectaban a 'failed', perdiendo la distinción).
  rate_limited: 'rate_limited',
  not_configured: 'not_configured',
  ingest_failed: 'ingest_failed',
};

export function toDbStatus(fineState: SourceRunFineState): SourceRunDbStatus {
  return FINE_TO_DB[fineState];
}

/** true solo para el estado sano; cualquier otro NUNCA debe leerse como "cero oportunidades" (REQ-148, tolerancia cero). */
export function isHealthy(fineState: SourceRunFineState): boolean {
  return fineState === 'ok';
}
