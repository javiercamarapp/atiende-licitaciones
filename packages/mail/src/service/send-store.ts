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
 */
export interface SendRecordStore {
  get(messageKey: string): Promise<SendRecord | undefined>;
  save(record: SendRecord): Promise<void>;
}

export class InMemorySendRecordStore implements SendRecordStore {
  private readonly records = new Map<string, SendRecord>();

  async get(messageKey: string): Promise<SendRecord | undefined> {
    return this.records.get(messageKey);
  }

  async save(record: SendRecord): Promise<void> {
    this.records.set(record.messageKey, record);
  }

  /** Conveniencia de pruebas: todos los registros guardados hasta ahora. */
  all(): SendRecord[] {
    return [...this.records.values()];
  }
}
