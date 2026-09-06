import type { DbClient } from '@atiende/db';
import type { SendRecord, SendRecordStore, SendStatus } from '@atiende/mail';

/**
 * Implementación real de `SendRecordStore` (packages/mail/src/service/send-store.ts)
 * sobre la tabla `mail_outbox` (packages/db/migrations/0080_req181_mail_outbox.sql).
 *
 * Toda operación pasa por una función SECURITY DEFINER (`app.mail_outbox_*`)
 * -- `mail_outbox` es una tabla de sistema con RLS habilitada SIN políticas
 * (mismo patrón que `refresh_tokens`/`oauth_states`), porque un correo de
 * verificación o de restablecimiento de contraseña se manda ANTES de que
 * exista sesión. `get()` nunca ve un estado `pending`: la propia función
 * SQL lo filtra (ver docstring de la migración) para no romper el
 * contrato `SendStatus` de packages/mail.
 *
 * `reserve(messageKey)` es la ÚNICA operación de la interfaz que
 * `MailService.send()` invoca sin darle más contexto que el propio
 * `messageKey` -- no hay forma de pasarle el `templateId` real sin un
 * estado mutable compartido (inseguro bajo llamadas concurrentes a
 * `mailService.send()` con `messageKey` DISTINTOS, que sí deben poder
 * ejecutarse en paralelo). Para no perder esa columna, esta clase exige
 * (documentado también en `send-transactional.ts`, el único llamador real
 * de `apps/api`) que TODO `messageKey` de este proyecto siga la
 * convención `"<templateId>:<resto>"` (igual que los ejemplos del propio
 * README de packages/mail, p.ej. `"email-verification:<userId>"`) -- el
 * `templateId` de la fila se deriva del propio `messageKey`, sin
 * necesitar un canal aparte -- `send-transactional.ts` es el ÚNICO lugar
 * de `apps/api` que arma un `messageKey`, así que esa convención se
 * cumple por construcción, no por disciplina de cada llamador.
 */
export class PgSendRecordStore implements SendRecordStore {
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
}
