import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getTemplate } from '@atiende/mail';
import type { NotificationPreferences, RegisteredRecipient, SendOutcome } from '@atiende/mail';
import { readNotificationPreferences } from './preferences.js';

/** Espera antes del PRIMER reintento diferido: `MailService` ya agotó su
 *  propio backoff (segundos) dentro de la misma llamada, así que este job
 *  existe para una caída MÁS LARGA que eso -- reintentarlo de inmediato solo
 *  gastaría un intento. */
const MAIL_RETRY_DELAY_SECONDS = 300;
const MAIL_RETRY_MAX_ATTEMPTS = 5;

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
    preferences: input.preferences ?? (await resolvePreferences(app, input)),
    fromLocalPart: input.fromLocalPart,
  });

  // AM-03 (docs/auditoria-2/api-mail.md, ALTA): respalda el destinatario
  // real en `mail_outbox.to_email` -- columna que `PgSendRecordStore`
  // (`reserve()`/`save()`, ver su docstring) nunca escribe, porque
  // `SendRecordStore` (packages/mail) es agnóstico del contrato de negocio
  // y no expone el destinatario en ninguno de sus métodos. Este es el ÚNICO
  // punto de `apps/api` que conoce, en el mismo instante, tanto el
  // `messageKey` (== `dedupe_key`) como el destinatario REAL ya validado
  // (`assertRegisteredRecipient`, dentro de `MailService.send()`) -- de ahí
  // que el webhook (`modules/mail/webhook.routes.ts` ->
  // `lib/mail/pg-outbox-lookup.ts`) pueda cruzar un `provider_message_id`
  // contra el destinatario verdadero de ese envío, y no solo contra su
  // existencia. `where to_email is null` es un backfill idempotente: nunca
  // pisa una fila que ya tiene destinatario (p. ej. un reintento posterior
  // con el mismo `messageKey`). Un solo destinatario -- con varios (poco
  // frecuente en este módulo, ver `resolvePreferences` arriba) no hay UNA
  // columna que llenar de forma inequívoca, así que se omite: esas filas
  // quedan como antes (`to_email` NULL, el webhook las trata como
  // "sin envío correspondiente", nunca como pretexto para suprimir).
  // Best-effort: un fallo aquí nunca debe convertir un envío YA REALIZADO
  // en un error para el llamador.
  if (!Array.isArray(input.to)) {
    try {
      await app.db.query('update mail_outbox set to_email = $1 where dedupe_key = $2 and to_email is null', [
        input.to.email,
        input.messageKey,
      ]);
    } catch (error) {
      app.log.error(
        { err: error instanceof Error ? error.message : String(error), messageKey: input.messageKey },
        'No se pudo respaldar mail_outbox.to_email (AM-03)'
      );
    }
  }

  if (outcome.status === 'dead') {
    await app.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      // `app.enqueue_mail_retry` (SECURITY DEFINER, migración 0086) y no un
      // INSERT directo: la política `ins_jobs` (0028) exige `worker_role`,
      // superadmin, o un miembro de la organización DUEÑA del job -- y un
      // correo de verificación o de restablecimiento de contraseña no tiene
      // ni organización ni sesión, así que el INSERT directo se rechazaba
      // por RLS justo para los correos más críticos. La función está acotada
      // a `kind = 'mail_retry'`: nunca permite crear un job arbitrario.
      await tx.query('select app.enqueue_mail_retry($1, $2, $3::jsonb, $4, $5, $6)', [
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
        MAIL_RETRY_DELAY_SECONDS,
        MAIL_RETRY_MAX_ATTEMPTS,
        null,
      ]);
    });
  }

  return outcome;
}

/**
 * REQ-181..195: las preferencias del destinatario, cargadas de
 * `notification_preferences` (0082) cuando hacen falta -- y SOLO cuando
 * hacen falta.
 *
 * Tres condiciones, cada una por una razón distinta:
 *
 *  - **Plantilla OPCIONAL.** Una obligatoria (`account_security`,
 *    `internal`: verificación, contraseña, 2FA, invitación, contacto
 *    interno) no se puede apagar -- `isCategoryEnabled` de packages/mail ni
 *    siquiera mira las preferencias -- así que consultarlas sería una
 *    lectura a la base por cada correo de seguridad, para nada.
 *  - **Un solo destinatario.** Con varios no hay UNA preferencia que
 *    aplicar: quien mande un correo a varias personas debe filtrarlas antes
 *    (o mandar uno por persona, que es lo que hace todo este módulo hoy).
 *  - **`userId` con forma de UUID.** `RegisteredRecipient.userId` no siempre
 *    es una fila de `users`: para una invitación es el id de la invitación y
 *    para el buzón interno es la constante `internal-inbox` (ver
 *    `recipients.ts`). Ambos casos son plantillas obligatorias, así que ya
 *    quedaron fuera arriba; esta comprobación es el cinturón por si mañana
 *    aparece un destinatario opcional sin cuenta.
 *
 * Un fallo al leerlas NO bloquea el envío: se sigue con los valores por
 * defecto (todo activado), que es el mismo criterio de "ausencia de fila"
 * de la propia migración -- una lectura fallida nunca debe silenciar un
 * aviso de plazo que la persona sí quería.
 */
async function resolvePreferences<V>(
  app: FastifyInstance,
  input: SendTransactionalMailInput<V>
): Promise<NotificationPreferences | undefined> {
  const template = getTemplate(input.templateId);
  if (!template || template.mandatory) return undefined;

  const recipients = Array.isArray(input.to) ? input.to : [input.to];
  if (recipients.length !== 1) return undefined;
  const userId = recipients[0].userId;
  if (!UUID_PATTERN.test(userId)) return undefined;

  try {
    return await readNotificationPreferences(app, userId);
  } catch (error) {
    app.log.error(
      { err: error instanceof Error ? error.message : String(error), userId },
      'No se pudieron leer las preferencias de notificación; se usan los valores por defecto'
    );
    return undefined;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
