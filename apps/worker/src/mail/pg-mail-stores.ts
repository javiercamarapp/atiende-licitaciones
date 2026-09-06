import type { DbClient } from '@atiende/db';
import type { SendRecord, SendRecordStore, SendStatus, SuppressionEntry, SuppressionReason, SuppressionStore } from '@atiende/mail';

/**
 * REQ-188 (S7, docs/ACEPTACION.md): implementación de `SendRecordStore`
 * (packages/mail/src/service/send-store.ts) sobre la tabla `mail_outbox`
 * (packages/db/migrations/0080_req181_mail_outbox.sql) para el `MailService`
 * de `apps/worker`.
 *
 * DUPLICADA A PROPÓSITO de `apps/api/src/lib/mail/pg-send-record-store.ts`
 * (mismo contrato, mismo SQL contra las MISMAS funciones SECURITY DEFINER
 * `app.mail_outbox_*`), en vez de importada: el ámbito de este cambio es
 * `apps/worker/**` (ver `apps/worker/README.md`) y `apps/api` es de otro
 * agente en curso — importar entre dos `apps/*` cruzaría esa frontera
 * (ninguno de los dos exporta una superficie pública pensada para que el
 * otro la consuma, a diferencia de `packages/*`). Ambas implementaciones
 * comparten el mismo esquema real (`mail_outbox`) y las mismas funciones
 * `SECURITY DEFINER`, así que la reserva atómica (`reserve()`, ML-01) que
 * evita un doble envío cuando `apps/api` y `apps/worker` compiten por la
 * MISMA `messageKey` (el reintento diferido de un envío que la propia API
 * ya intentó) sigue siendo una única fuente de verdad en la base de datos,
 * no en el código de cada proceso.
 */
export class PgMailOutboxStore implements SendRecordStore {
  constructor(
    private readonly db: DbClient,
    private readonly maxAttempts = 5,
  ) {}

  async get(messageKey: string): Promise<SendRecord | undefined> {
    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{
        dedupe_key: string;
        template_id: string;
        status: SendStatus;
        provider_message_id: string | null;
        attempts: number;
        max_attempts: number;
        last_error: string | null;
        updated_at: string;
      }>('select * from app.mail_outbox_get($1)', [messageKey]);
    });
    const row = rows[0];
    if (!row) return undefined;
    return {
      messageKey: row.dedupe_key,
      templateId: row.template_id,
      status: row.status,
      providerMessageId: row.provider_message_id ?? undefined,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  async save(record: SendRecord): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query('select app.mail_outbox_save($1, $2, $3, $4, $5, $6)', [
        record.messageKey,
        record.status,
        record.providerMessageId ?? null,
        record.attempts,
        record.maxAttempts,
        record.lastError ?? null,
      ]);
    });
  }

  async reserve(messageKey: string): Promise<boolean> {
    const templateId = messageKey.includes(':') ? messageKey.slice(0, messageKey.indexOf(':')) : 'desconocida';
    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ id: string | null }>('select app.mail_outbox_reserve($1, $2, $3, null, null, null) as id', [
        messageKey,
        templateId,
        this.maxAttempts,
      ]);
    });
    return rows[0]?.id !== null && rows[0]?.id !== undefined;
  }

  async release(messageKey: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query('select app.mail_outbox_release($1)', [messageKey]);
    });
  }

  /**
   * REQ-188 (0087, `app.mail_outbox_reopen_for_retry`): fuera del contrato
   * genérico `SendRecordStore` de `@atiende/mail` a propósito -- es una
   * operación específica del caso de uso "job `mail_retry` reintenta un
   * envío que quedó `dead`" (ver docstring extenso de la función SQL). Sin
   * esto, `reserve()` jamás vuelve a devolver `true` para una `messageKey`
   * ya `dead`: `MailService.send()` la vería para siempre como `dead` sin
   * volver a tocar el proveedor, sin importar cuántas veces se reintente el
   * job. Devuelve `true` solo si de verdad reabrió una fila `dead` (una
   * `messageKey` ya `sent`/`failed_permanent`/inexistente es un no-op
   * silencioso, no un error).
   */
  async reopenDeadForRetry(messageKey: string): Promise<boolean> {
    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ reopened: boolean | null }>('select app.mail_outbox_reopen_for_retry($1) as reopened', [messageKey]);
    });
    return rows[0]?.reopened === true;
  }
}

/**
 * REQ-188: implementación de `SuppressionStore` (packages/mail/src/
 * suppression/types.ts) sobre `mail_suppressions`
 * (packages/db/migrations/0081_req181_mail_suppression_and_webhook_replay.sql).
 * Misma nota de "DUPLICADA A PROPÓSITO" que `PgMailOutboxStore` de arriba:
 * es el mismo contrato que `apps/api/src/lib/mail/pg-suppression-store.ts`
 * sobre la MISMA tabla y las MISMAS funciones `SECURITY DEFINER`.
 */
export class PgMailSuppressionStore implements SuppressionStore {
  constructor(private readonly db: DbClient) {}

  async isSuppressed(email: string): Promise<boolean> {
    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ suppressed: boolean }>('select app.mail_suppression_check($1) as suppressed', [email]);
    });
    return rows[0]?.suppressed ?? false;
  }

  async suppress(email: string, reason: SuppressionReason, source: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query('select app.mail_suppression_add($1, $2, $3)', [email, reason, source]);
    });
  }

  async unsuppress(email: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query('select app.mail_suppression_remove($1)', [email]);
    });
  }

  async get(email: string): Promise<SuppressionEntry | undefined> {
    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ email: string; reason: SuppressionReason; source: string; created_at: string }>(
        'select * from app.mail_suppression_get($1)',
        [email],
      );
    });
    const row = rows[0];
    if (!row) return undefined;
    return { email: row.email, reason: row.reason, source: row.source, createdAt: row.created_at };
  }
}
