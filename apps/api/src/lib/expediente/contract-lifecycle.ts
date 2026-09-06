/**
 * REQ-051: máquina de estados del contrato post-adjudicación (ronda 6).
 *
 * Igual precedente que `STEP_UP_PURPOSES` (`lib/step-up.ts`): la tabla de
 * transiciones válidas vive como una lista CERRADA en código (nunca en un
 * string libre ni en una tabla editable en runtime), para que cualquier
 * transición nueva exija tocar este archivo -- y su prueba exhaustiva --
 * antes de poder usarse. `contract_status_history` (migración 0065) sí
 * persiste el HISTORIAL real de transiciones ejecutadas (inmutable, solo
 * INSERT/SELECT), pero el CATÁLOGO de qué transición es válida es esta
 * tabla, no una tabla de base de datos.
 *
 * Estados pedidos explícitamente por la tarea despachada de esta ronda
 * (item 1): "adjudicado → contrato_firmado_declarado → en_ejecución →
 * entregado → facturado → pagado → cerrado, con ramas: modificado,
 * penalizado, rescindido, en_inconformidad". Nótese que esto difiere del
 * texto original de REQ-051 en `docs/REQUISITOS.md` ("adjudicado→firmado→
 * garantía→entrega→aceptado→factura→pagado→liberado") -- se documenta la
 * discrepancia en `apps/api/docs/e11-cobertura.md`; esta ronda implementa
 * los estados tal como los especificó la tarea despachada.
 *
 * "contrato_firmado_declarado" (no "contrato_firmado"): el sistema NUNCA
 * firma ni verifica una firma real (ver REQ-052/`contract-extraction.ts`)
 * -- el nombre del estado deja explícito que es una DECLARACIÓN del
 * usuario de que el contrato ya fue firmado fuera de este sistema, nunca
 * un hecho verificado criptográficamente.
 */

export const CONTRACT_STATES = [
  'adjudicado',
  'contrato_firmado_declarado',
  'en_ejecucion',
  'entregado',
  'facturado',
  'pagado',
  'cerrado',
  'modificado',
  'penalizado',
  'rescindido',
  'en_inconformidad',
] as const;

export type ContractStatus = (typeof CONTRACT_STATES)[number];

export const CONTRACT_INITIAL_STATUS: ContractStatus = 'adjudicado';

/** Estados terminales: ninguna transición sale de ellos. */
export const CONTRACT_TERMINAL_STATES: readonly ContractStatus[] = ['cerrado'];

/**
 * Tabla de transiciones válidas (estado actual -> conjunto de estados
 * siguientes permitidos). Las ramas ("modificado", "penalizado",
 * "rescindido", "en_inconformidad") pueden alcanzarse desde varios puntos
 * del flujo principal y, salvo "rescindido"/"en_inconformidad" resuelto,
 * regresan al flujo principal desde el mismo punto donde se registraron
 * (nunca saltan estados intermedios).
 */
export const CONTRACT_TRANSITIONS: Readonly<Record<ContractStatus, readonly ContractStatus[]>> = {
  adjudicado: ['contrato_firmado_declarado', 'en_inconformidad', 'rescindido'],
  contrato_firmado_declarado: ['en_ejecucion', 'modificado', 'rescindido', 'en_inconformidad'],
  en_ejecucion: ['entregado', 'modificado', 'penalizado', 'rescindido'],
  entregado: ['facturado', 'modificado', 'penalizado'],
  facturado: ['pagado', 'penalizado'],
  pagado: ['cerrado'],
  modificado: ['en_ejecucion', 'entregado', 'facturado', 'pagado', 'penalizado', 'rescindido'],
  penalizado: ['en_ejecucion', 'entregado', 'facturado', 'pagado', 'rescindido'],
  rescindido: ['cerrado'],
  en_inconformidad: ['adjudicado', 'contrato_firmado_declarado', 'cerrado'],
  cerrado: [],
};

/**
 * Subconjunto de estados que, al alcanzarse, encolan una alerta (`jobs`,
 * kind='contract_state_alert', sin envío externo -- ver `contract.routes.ts`):
 * estados que requieren atención humana inmediata (rama excepcional o cierre).
 */
export const CONTRACT_ALERT_STATES: readonly ContractStatus[] = ['penalizado', 'rescindido', 'en_inconformidad', 'cerrado'];

/**
 * Transiciones que exigen verificación en dos pasos (2FA/step-up,
 * `purpose='expediente.contract_transition'`, ver `lib/step-up.ts` y
 * migración 0066) por representar una decisión económica/legal sensible:
 * rescindir el contrato, registrar una penalización, marcar una
 * inconformidad, o registrar una modificación. Distinto -- aunque
 * solapado -- de `CONTRACT_ALERT_STATES` ("cerrado" genera alerta pero no
 * es en sí mismo una decisión nueva, es la consecuencia de una ya
 * autorizada antes).
 */
export const CONTRACT_STEP_UP_TRANSITIONS: readonly ContractStatus[] = ['rescindido', 'penalizado', 'en_inconformidad', 'modificado'];

export function isContractStatus(value: unknown): value is ContractStatus {
  return typeof value === 'string' && (CONTRACT_STATES as readonly string[]).includes(value);
}

export interface TransitionCheckResult {
  valid: boolean;
  allowedNextStates: readonly ContractStatus[];
}

/** Nunca lanza -- el llamador decide el código de error (409) con el detalle de `allowedNextStates`. */
export function checkTransition(fromStatus: ContractStatus, toStatus: ContractStatus): TransitionCheckResult {
  const allowed = CONTRACT_TRANSITIONS[fromStatus] ?? [];
  return { valid: allowed.includes(toStatus), allowedNextStates: allowed };
}
