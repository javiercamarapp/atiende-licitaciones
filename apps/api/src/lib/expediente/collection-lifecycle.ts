/**
 * REQ-051 (ronda de cobranza): máquina de estados de COBRANZA para
 * seguimientos post-adjudicación de tipo `kind='facturacion'`/`kind='pago'`
 * (`post_award_followups` -- ver `post-award.routes.ts` para el
 * `cfdiReference`/`acceptanceDate` que ya existían y que esta máquina
 * REUSA, sin duplicar el modelo).
 *
 * Mismo precedente que `contract-lifecycle.ts` (REQ-051 del contrato
 * completo, ronda 6): el CATÁLOGO de transiciones válidas vive como una
 * lista CERRADA en código, nunca en un string libre ni en una tabla
 * editable en runtime -- `collection_status_history` (migración
 * 0094_req051_collection_lifecycle.sql) persiste el HISTORIAL real de
 * transiciones ejecutadas (inmutable, solo INSERT/SELECT), pero el
 * CATÁLOGO de qué transición es válida es este archivo.
 *
 * Distinto -- aunque relacionado -- de `contract-lifecycle.ts`: el
 * contrato tiene sus propios estados generales "facturado"/"pagado" (todo
 * el contrato), mientras que esta máquina trackea el ciclo de COBRO de
 * CADA factura/pago individual registrado como `post_award_followup`
 * (una convocatoria puede tener varias facturas con cobranza en distintos
 * puntos del ciclo a la vez).
 *
 * Regla dura (transversal, ver docs/BLOQUEOS.md y la tarea despachada):
 * "pagada" NUNCA se marca automáticamente -- exige una acción humana
 * explícita (step-up/2FA reciente, mismo mecanismo que
 * `expediente.contract_transition`) que la confirme. Es dinero real, no
 * se infiere de una fecha ni de una regla heurística.
 */

export const COLLECTION_STATES = [
  'emitida',
  'enviada',
  'en_revision',
  'aprobada_para_pago',
  'pagada',
  'vencida_sin_pago',
  'en_disputa',
] as const;

export type CollectionStatus = (typeof COLLECTION_STATES)[number];

export const COLLECTION_INITIAL_STATUS: CollectionStatus = 'emitida';

/** Estados terminales: ninguna transición sale de ellos. */
export const COLLECTION_TERMINAL_STATES: readonly CollectionStatus[] = ['pagada'];

/**
 * Tabla de transiciones válidas (estado actual -> conjunto de estados
 * siguientes permitidos). "en_disputa" y "vencida_sin_pago" son ramas
 * excepcionales alcanzables desde varios puntos del flujo principal, y
 * ambas pueden regresar al flujo normal (aprobada_para_pago/en_revision)
 * si la disputa se resuelve o el pago finalmente se recibe -- nunca saltan
 * a "pagada" sin pasar por una decisión explícita de esa transición
 * puntual (que de todos modos exige step-up, ver
 * `COLLECTION_STEP_UP_TRANSITIONS`).
 */
export const COLLECTION_TRANSITIONS: Readonly<Record<CollectionStatus, readonly CollectionStatus[]>> = {
  emitida: ['enviada', 'en_disputa'],
  enviada: ['en_revision', 'en_disputa'],
  en_revision: ['aprobada_para_pago', 'en_disputa'],
  aprobada_para_pago: ['pagada', 'vencida_sin_pago', 'en_disputa'],
  vencida_sin_pago: ['aprobada_para_pago', 'pagada', 'en_disputa'],
  en_disputa: ['en_revision', 'aprobada_para_pago', 'vencida_sin_pago'],
  pagada: [],
};

/**
 * Subconjunto de estados que, al alcanzarse, encolan una alerta (`jobs`,
 * kind='collection_status_alert', sin envío externo -- mismo patrón que
 * `contract_state_alert`): cobranza vencida sin pago, o en disputa activa.
 * Reutilizado además por `computeAlertLevel` (`post-award.routes.ts`) para
 * que `GET /expediente/post-award-alerts` (REQ-056, ya existente) también
 * agregue estas cobranzas -- sin inventar un mecanismo de alerta nuevo.
 */
export const COLLECTION_ALERT_STATES: readonly CollectionStatus[] = ['vencida_sin_pago', 'en_disputa'];

/**
 * Transiciones que exigen verificación en dos pasos (2FA/step-up,
 * `purpose='expediente.collection_transition'`) por representar dinero
 * real confirmado como cobrado: únicamente "pagada". Regla dura de la
 * tarea despachada -- "nunca marcar 'pagada' automáticamente sin una
 * acción humana explícita que lo confirme" -- se aplica en código, no solo
 * en documentación: ver `checkTransition`/`collection.routes.ts`.
 */
export const COLLECTION_STEP_UP_TRANSITIONS: readonly CollectionStatus[] = ['pagada'];

export function isCollectionStatus(value: unknown): value is CollectionStatus {
  return typeof value === 'string' && (COLLECTION_STATES as readonly string[]).includes(value);
}

export interface CollectionTransitionCheckResult {
  valid: boolean;
  allowedNextStates: readonly CollectionStatus[];
}

/** Nunca lanza -- el llamador decide el código de error (409) con el detalle de `allowedNextStates`. */
export function checkCollectionTransition(fromStatus: CollectionStatus, toStatus: CollectionStatus): CollectionTransitionCheckResult {
  const allowed = COLLECTION_TRANSITIONS[fromStatus] ?? [];
  return { valid: allowed.includes(toStatus), allowedNextStates: allowed };
}
