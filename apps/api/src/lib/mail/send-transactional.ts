import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { NotificationPreferences, RegisteredRecipient, SendOutcome } from '@atiende/mail';

export interface SendTransactionalMailInput<V = unknown> {
  to: RegisteredRecipient | RegisteredRecipient[];
  templateId: string;
  variables: V;
  /**
   * Llave de idempotencia del ENVÍO DE NEGOCIO -- ver
   * packages/mail/README.md. CONVENCIÓN OBLIGATORIA de este proyecto (ver
   * docstring de `PgSendRecordStore`): debe empezar con `"<templateId>:"`
   * -- todas las llamadas de este módulo la arman así.
   */
  messageKey: string;
  preferences?: NotificationPreferences;
  fromLocalPart?: string;
  /** Solo para que el job de reintento (ver abajo) quede asociado a la organización correcta -- `null` para correos sin organización (verificación de correo, restablecimiento de contraseña, 2FA). */
  orgId?: string | null;
}

/**
 * Punto único por el que `apps/api` manda cualquier correo transaccional.
 * Delega en `app.mail.send()` (MailService, que ya reintenta con backoff
 * DENTRO de esta misma llamada -- ver packages/mail/README.md) y, si aun
 * así el envío termina `dead` (reintentos de MailService agotados), encola
 * un job de reintento DIFERIDO en la tabla `jobs` -- capa adicional de
 * reintento sobre la que ya hace `MailService` por dentro, para no dejar
 * un correo transaccional importante (verificación, restablecimiento de
 * contraseña, invitación) varado por una caída temporal más larga que el
 * backoff interno.
 *
 * ## Contrato del job `mail_retry` (para `apps/worker`)
 *
 * `apps/worker` NO está en el ámbito de este cambio (ver README de este
 * módulo) -- este es el contrato que un futuro handler
 * (`apps/worker/src/handlers/mail-retry.ts`, análogo a
 * `send-agent-alert.ts`) debe implementar:
 *
 * ```ts
 * // payload de jobs.kind = 'mail_retry':
 * interface MailRetryJobPayload {
 *   templateId: string;
 *   to: RegisteredRecipient | RegisteredRecipient[];
 *   variables: unknown;       // ya validado una vez por el schema de la plantilla
 *   messageKey: string;       // MISMA llave -- MailService.send() es idempotente por ella
 *   preferences: NotificationPreferences | null;
 *   fromLocalPart: string | null;
 * }
 * ```
 *
 * El handler debe: construir el mismo `MailService` (`buildMailServiceFromEnv`,
 * reutilizable tal cual desde `apps/worker` porque solo depende de
 * `DbClient` + variables de entorno, ninguna de las dos exclusiva de
 * `apps/api`) y volver a llamar a `mailService.send({...payload})` --
 * `MailService` ve la MISMA `messageKey` ya en estado `dead` y, si el
 * proveedor sigue fallando, vuelve a agotar sus propios reintentos y
 * regresa `dead` de nuevo (el job se reintenta según `jobs.max_attempts`,
 * backoff estándar de `apps/worker/src/queue/job-queue.ts`); si el
 * proveedor ya se recuperó, el envío se completa y `mail_outbox` pasa a
 * `sent` normalmente.
 */
export async function sendTransactionalMail<V>(app: FastifyInstance, input: SendTransactionalMailInput<V>): Promise<SendOutcome> {
  const outcome = await app.mail.send({
    to: input.to,
    templateId: input.templateId,
    variables: input.variables,
    messageKey: input.messageKey,
    preferences: input.preferences,
    fromLocalPart: input.fromLocalPart,
  });

  if (outcome.status === 'dead') {
    await app.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query(
        `insert into jobs (id, org_id, kind, payload, status, next_run_at, max_attempts)
         values ($1, $2, 'mail_retry', $3::jsonb, 'queued', now() + interval '5 minutes', 5)`,
        [
          randomUUID(),
          input.orgId ?? null,
          JSON.stringify({
            templateId: input.templateId,
            to: input.to,
            variables: input.variables,
            messageKey: input.messageKey,
            preferences: input.preferences ?? null,
            fromLocalPart: input.fromLocalPart ?? null,
          }),
        ],
      );
    });
  }

  return outcome;
}
