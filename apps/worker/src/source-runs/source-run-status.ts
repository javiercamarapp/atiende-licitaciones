/**
 * Estado explícito de una corrida de fuente, con la granularidad exacta
 * pedida en esta ronda (REQ-148/AMPLIACION-BACKOFFICE §2): activa, caída,
 * CAPTCHA, cambio de interfaz, permisos/autenticación faltante,
 * rate-limited y "no configurada" (fuente sin credenciales/URL real, o sin
 * verificación puntual documentada — REQ-150).
 *
 * `packages/db/migrations/0013_source_runs.sql` define un enum
 * `source_run_status` MÁS ANGOSTO (`ok|failed|captcha|interface_changed|
 * permission_missing|down`, sin `rate_limited` ni `not_configured`) — no se
 * tocó esa migración en esta ronda (fuera de alcance: packages/db). Este
 * módulo guarda el estado fino real siempre en `evidence.fineState`/
 * `evidence.message` (columna `jsonb`, sin restricción de esquema) y solo
 * proyecta el valor más cercano hacia la columna `status` para que las
 * consultas existentes (`status = 'ok'`, etc.) seguirán funcionando. Ver
 * README §Pendientes: recomendación de migración futura para
 * `packages/db` que amplíe el enum con `rate_limited`/`not_configured` y
 * elimine la necesidad de esta proyección.
 */
export type SourceRunFineState =
  | 'ok'
  | 'down'
  | 'captcha_detected'
  | 'interface_changed'
  | 'permission_missing'
  | 'rate_limited'
  | 'not_configured';

/** Estado de la columna real `source_runs.status` (packages/db, sin tocar en esta ronda). */
export type SourceRunDbStatus = 'ok' | 'failed' | 'captcha' | 'interface_changed' | 'permission_missing' | 'down';

const FINE_TO_DB: Record<SourceRunFineState, SourceRunDbStatus> = {
  ok: 'ok',
  down: 'down',
  captcha_detected: 'captcha',
  interface_changed: 'interface_changed',
  permission_missing: 'permission_missing',
  // Sin equivalente exacto en el enum actual: se proyectan como 'failed'
  // (nunca como 'ok') y el detalle real vive en evidence.fineState/message.
  rate_limited: 'failed',
  not_configured: 'failed',
};

export function toDbStatus(fineState: SourceRunFineState): SourceRunDbStatus {
  return FINE_TO_DB[fineState];
}

/** true solo para el estado sano; cualquier otro NUNCA debe leerse como "cero oportunidades" (REQ-148, tolerancia cero). */
export function isHealthy(fineState: SourceRunFineState): boolean {
  return fineState === 'ok';
}
