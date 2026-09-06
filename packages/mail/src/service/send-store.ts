/**
 * Vocabulario alineado con el outbox transaccional de Atiende Restaurantes
 * (`messaging_outbox`, `docs/investigacion/salida-promocion-referencias.md`
 * §2.1): `sent` y `dead` son los mismos nombres que esa tabla usa para "se
 * mandó" y "se agotaron los reintentos, no se vuelve a intentar solo".
 * `failed_permanent` es la variante propia de este paquete para un rechazo
 * del PROVEEDOR que no es cuestión de reintentar (4xx: remitente inválido,
 * plantilla mal formada) — la tabla real de `apps/api` puede mapearlo a su
 * propio `dead` si prefiere un solo estado terminal.
 */
export type SendStatus = "sent" | "failed_permanent" | "dead";

export interface SendRecord {
  messageKey: string;
  templateId: string;
  status: SendStatus;
  providerMessageId?: string;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  updatedAt: string;
}

/**
 * El contrato de idempotencia/outbox que `MailService` necesita — es una
 * INTERFAZ, sin persistencia real, con el mismo criterio que
 * `packages/agents` usa para `RunStore`/`ToolCallStore`: este paquete no
 * depende de ninguna base de datos. `apps/api`/`apps/worker` implementan
 * esta interfaz contra una tabla real tipo `messaging_outbox` (con
 * `dedupe_key = messageKey`, y sus propias columnas de `lease`/`fence_token`
 * si necesitan que varios procesos reclamen envíos sin pisarse — esta
 * versión en memoria (`InMemorySendRecordStore`) es solo para pruebas y
 * para el default de un `MailService` sin persistencia configurada).
 *
 * Si ya existe un registro con estado `sent` para una `messageKey`,
 * `MailService.send()` no vuelve a mandar el correo — el llamador arma la
 * llave (p. ej. `verificacion:<userId>` o
 * `resumen-semanal:<organizationId>:<semanaISO>`) de modo que un reintento
 * de SU lado (una cola que reprocesa, un doble clic) nunca duplique el
 * envío.
 *
 * ## ML-01 — reserve(): la operación atómica que falta para concurrencia real
 *
 * get()+save() por sí solos son un patrón check-then-act: si dos llamadas
 * concurrentes (mismo messageKey) hacen get() casi al mismo tiempo, AMBAS ven
 * "no existe" y ambas terminan llamando al MailProvider real antes de que
 * ninguna alcance a hacer save(). reserve() es la operación de
 * compare-and-set que cierra esa ventana: MailService.send() la invoca justo
 * ANTES de tocar el proveedor, y solo quien reciba true continúa — quien
 * reciba false nunca llama al proveedor.
 *
 * La implementación real sobre Postgres (apps/api/apps/worker) resuelve esto
 * con una restricción UNIQUE sobre dedupe_key y:
 *
 *   INSERT INTO messaging_outbox (dedupe_key, status, ...)
 *   VALUES ($1, 'pending', ...)
 *   ON CONFLICT (dedupe_key) DO NOTHING;
 *   -- reserve() === true  si rowCount === 1 (esta llamada ganó la reserva)
 *   -- reserve() === false si rowCount === 0 (alguien más ya la tenía)
 *
 * InMemorySendRecordStore.reserve() reproduce la misma semántica con un Map
 * y una comprobación-y-escritura SÍNCRONA (sin ningún await de por medio):
 * JavaScript no interrumpe código síncrono a medio camino, así que dos
 * llamadas que compiten por la misma messageKey (p. ej. dentro de un
 * Promise.all) nunca pueden ver ambas "libre" — la primera en ejecutar la
 * comprobación ya dejó la marca puesta antes de que la segunda alcance a
 * leerla. Es la contraparte en memoria de la "promesa en vuelo": mientras la
 * reserva sigue viva, cualquier otra llamada para la misma llave pierde de
 * inmediato, sin esperar a que el envío real termine.
 */
export interface SendRecordStore {
  get(messageKey: string): Promise<SendRecord | undefined>;
  save(record: SendRecord): Promise<void>;
  /**
   * Compare-and-set atómico: `true` SOLO para quien gana la reserva de esta
   * `messageKey` (ni ya está `sent`, ni alguien más la tiene reservada en
   * este momento) — quien gana debe, tarde o temprano, llamar a `save()`
   * (o a `release()` si aborta antes de tocar el proveedor) para esa misma
   * llave. `false` para cualquier otra llamada concurrente o posterior
   * mientras la reserva sigue viva.
   */
  reserve(messageKey: string): Promise<boolean>;
  /**
   * Libera una reserva de `reserve()` SIN escribir un registro final —
   * úsese solo cuando el envío se abortó ANTES de intentar el proveedor
   * (p. ej. `not_configured`) y se quiere permitir que una llamada
   * POSTERIOR (no concurrente) con la misma `messageKey` pueda reintentar.
   * Opcional: una implementación real sobre Postgres puede simplemente
   * borrar la fila `pending` que dejó `reserve()` (o dejarla expirar por
   * `lease_until`) si no quiere exponer esta operación por separado.
   */
  release?(messageKey: string): Promise<void>;
}

export class InMemorySendRecordStore implements SendRecordStore {
  private readonly records = new Map<string, SendRecord>();
  /** Reservas en vuelo (ver `reserve()` en la interfaz de arriba) — separado
   *  de `records` porque una reserva NO es todavía un resultado final. */
  private readonly reservations = new Set<string>();

  async get(messageKey: string): Promise<SendRecord | undefined> {
    return this.records.get(messageKey);
  }

  async save(record: SendRecord): Promise<void> {
    this.records.set(record.messageKey, record);
    this.reservations.delete(record.messageKey);
  }

  async reserve(messageKey: string): Promise<boolean> {
    // Todo lo de aquí abajo es SÍNCRONO a propósito (sin `await`): es lo que
    // hace que la comprobación-y-escritura sea atómica frente a llamadas
    // concurrentes — ver el comentario de la interfaz.
    if (this.records.get(messageKey)?.status === "sent") return false;
    if (this.reservations.has(messageKey)) return false;
    this.reservations.add(messageKey);
    return true;
  }

  async release(messageKey: string): Promise<void> {
    this.reservations.delete(messageKey);
  }

  /** Conveniencia de pruebas: todos los registros guardados hasta ahora. */
  all(): SendRecord[] {
    return [...this.records.values()];
  }
}
