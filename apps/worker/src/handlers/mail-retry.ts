import { z } from 'zod';
import type { DbClient } from '@atiende/db';
import { MailService, RegisteredRecipientSchema, type NotificationPreferences, type SendOutcome } from '@atiende/mail';
import type { JobHandler } from '../queue/types.js';
import { buildMailServiceForWorker } from '../mail/build-mail-service.js';
import type { PgMailOutboxStore } from '../mail/pg-mail-stores.js';

/**
 * REQ-188 / S7 (docs/ACEPTACION.md): "envío fallido reintenta vía job y
 * queda registrado con su historial de intentos".
 *
 * Contrato del payload de `jobs.kind = 'mail_retry'`, documentado por quien
 * lo encola (`apps/api/src/lib/mail/send-transactional.ts`, migración
 * `packages/db/migrations/0086_req181_mail_retry_job.sql`) -- se repite
 * aquí como el tipo REAL que este handler valida, no solo como comentario.
 * `variables` es `unknown` a propósito: ya pasó una vez por el `zod schema`
 * de la plantilla dentro de `apps/api` (`MailService.send()` lo vuelve a
 * validar aquí también, vía `template.schema.safeParse`, antes de volver a
 * intentar el envío -- REQ-188 no exime este reintento de esa validación).
 */
const NotificationPreferencesSchema = z
  .object({
    tenderMatches: z.boolean().optional(),
    tenderChanges: z.boolean().optional(),
    approvals: z.boolean().optional(),
    submission: z.boolean().optional(),
    deadlines: z.boolean().optional(),
    documentExpiration: z.boolean().optional(),
    postAward: z.boolean().optional(),
    weeklySummary: z.boolean().optional(),
  })
  .strict();

/**
 * Payload malformado (REQ-188, criterio "payload malformado -> rechazado
 * sin crash"): un `to` que no es UN destinatario registrado NI un arreglo
 * de al menos uno se rechaza AQUÍ, antes de tocar `MailService` -- nunca un
 * arreglo vacío (mismo criterio que `MailService.send()`, que trataría un
 * arreglo vacío como `unregistered_recipient`, pero ese caso es
 * indistinguible de un payload mal armado por quien lo encoló).
 */
const MailRetryJobPayloadSchema = z.object({
  templateId: z.string().min(1, 'templateId es obligatorio.'),
  to: z.union([RegisteredRecipientSchema, z.array(RegisteredRecipientSchema).min(1)]),
  variables: z.unknown(),
  messageKey: z.string().min(1, 'messageKey es obligatorio.'),
  preferences: NotificationPreferencesSchema.nullable().optional(),
  fromLocalPart: z.string().min(1).nullable().optional(),
});

export type MailRetryJobPayload = z.infer<typeof MailRetryJobPayloadSchema>;

export interface MailRetryHandlerDeps {
  db: DbClient;
  /** Inyectable para pruebas; por defecto usa `buildMailServiceForWorker()`
   *  (proveedor real según `MAIL_PROVIDER`, `CaptureProvider` sin
   *  credenciales -- ver ese archivo). Construido UNA VEZ por instancia de
   *  handler, igual que `createRunAgentHandler` hace con sus propios
   *  almacenes en memoria (ver `apps/worker/src/index.ts`). Si se inyecta
   *  `mailService` en pruebas SIN `outboxStore`, la reapertura de filas
   *  `dead` (ver más abajo) se omite -- las pruebas que la necesiten deben
   *  inyectar ambos juntos (`buildMailServiceForWorker()` ya los devuelve
   *  emparejados). */
  mailService?: MailService;
  outboxStore?: PgMailOutboxStore;
  env?: NodeJS.ProcessEnv;
}

/** Acciones permitidas de `app.record_mail_retry_event`
 *  (packages/db/migrations/0087_req188_mail_retry_audit.sql) -- una lista
 *  cerrada en SQL Y en TypeScript, doble cinturón. */
type MailRetryAuditAction =
  | 'mail_retry.sent'
  | 'mail_retry.already_sent'
  | 'mail_retry.skipped_preferences'
  | 'mail_retry.suppressed'
  | 'mail_retry.dead_permanent'
  | 'mail_retry.dead'
  | 'mail_retry.malformed_payload';

/**
 * `audit_log` (0087, SECURITY DEFINER: un correo sin organización --
 * verificación/restablecimiento de contraseña -- no tiene sesión ni sería
 * superadmin bajo `worker_role`/`app_role`, y la política de `audit_log`
 * exige exactamente eso cuando `org_id` es NULL). `correlationId` de
 * NEGOCIO (patrón WK6-02, `src/handlers/run-agent.ts`): `audit_log` no
 * tiene una columna dedicada para el identificador de negocio de este
 * flujo (a diferencia de `agent_runs.correlation_id`, ver E20), así que se
 * persiste dentro de `after` (JSONB) -- aquí ese identificador es la propia
 * `messageKey` (la llave de idempotencia de NEGOCIO del envío, ver
 * `packages/mail/README.md`), no `job.id` (identificador técnico de la
 * cola, distinto en cada intento).
 */
async function recordMailRetryEvent(
  db: DbClient,
  input: {
    action: MailRetryAuditAction;
    orgId: string | null;
    messageKey: string;
    jobId: string;
    after: Record<string, unknown>;
  },
): Promise<void> {
  const after = { correlationId: input.messageKey, jobId: input.jobId, ...input.after };
  await db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    await tx.query('select app.record_mail_retry_event($1, $2, $3, $4::jsonb, $5)', [
      input.action,
      input.orgId,
      input.messageKey,
      JSON.stringify(after),
      input.jobId,
    ]);
  });
}

/** Error clasificado como permanente (WK-10, `src/queue/errors.ts`):
 *  reintentar nunca cambia el resultado -- dead-letter inmediato, sin gastar
 *  el ciclo completo de backoff de `JobQueue.fail()`. */
class MailRetryPermanentError extends Error {
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'MailRetryPermanentError';
  }
}

function outcomeDetail(outcome: SendOutcome): string {
  switch (outcome.status) {
    case 'invalid_variables':
      return outcome.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    case 'unregistered_recipient':
      return outcome.detail;
    case 'failed_permanent':
      return outcome.detail;
    case 'dead':
      return outcome.detail;
    default:
      return '';
  }
}

/**
 * Handler del job `mail_retry` (REQ-188 / S7). Reutiliza el MISMO
 * `MailService` (`@atiende/mail`) que `apps/api` -- outbox (`reserve()`
 * CAS, ML-01) para nunca duplicar un envío, lista de supresión (fail-closed:
 * un error consultándola se trata como suprimido), y el backoff exponencial
 * interno de `MailService.send()` (`packages/mail/src/service/retry.ts`,
 * `DEFAULT_RETRY_POLICY`) para los reintentos DENTRO de esta misma llamada.
 *
 * Capa EXTERIOR de reintentos (entre invocaciones de este handler, cuando
 * `MailService` ya agotó los suyos y volvió a quedar `dead`): la maneja
 * `apps/worker/src/queue/job-queue.ts` de forma completamente genérica
 * (`JobQueue.fail()`, backoff exponencial + jitter, tope real en
 * `jobs.max_attempts` -- fijado en `MAIL_RETRY_MAX_ATTEMPTS` por
 * `send-transactional.ts` al encolar el job) -- este handler no reimplementa
 * ESE backoff, solo decide qué error lanzar (permanente vs. transitorio)
 * para que `Worker.process()` (`src/queue/worker.ts`) aplique el camino
 * correcto.
 *
 * Resultados posibles de `MailService.send()` y qué hace este handler con
 * cada uno:
 *
 *  - `sent`/`already_sent`/`skipped_preferences`/`skipped_suppressed`:
 *    estados FINALES exitosos (incluida la supresión: nunca se reintenta un
 *    envío a un destinatario suprimido, ni se reenvía uno ya `sent`) -- se
 *    deja rastro en `audit_log` y el job se completa normalmente (sin
 *    lanzar).
 *  - `not_configured`: sin proveedor real configurado todavía (ausencia de
 *    credenciales declarada, nunca un fallo de red -- ver
 *    `packages/mail/src/provider/factory.ts`) -- transitorio: se reintenta
 *    con backoff hasta que alguien configure un proveedor real o se agote
 *    `max_attempts`.
 *  - `invalid_variables`/`unregistered_recipient`/`failed_permanent`:
 *    permanentes -- el dato no cambiará solo reintentando (WK-10). Se
 *    audita como `mail_retry.dead_permanent` y se dead-letra de inmediato.
 *  - `dead`: `MailService` agotó sus propios reintentos internos en ESTA
 *    llamada -- transitorio a nivel de job (una caída del proveedor sí
 *    puede recuperarse en un intento POSTERIOR, más espaciado). Solo se
 *    audita como `mail_retry.dead` en el ÚLTIMO intento permitido
 *    (`job.attempts >= job.maxAttempts`), justo antes de que
 *    `JobQueue.fail()` lo dead-letre de verdad -- así el motivo del
 *    dead-letter queda en `audit_log`, no solo en `jobs.last_error`.
 *
 * Payload malformado (zod): se audita como `mail_retry.malformed_payload` y
 * se rechaza como error PERMANENTE, sin crashear el proceso -- `Worker`
 * captura cualquier excepción del handler (ver `src/queue/worker.ts`).
 */
export function createMailRetryHandler(deps: MailRetryHandlerDeps): JobHandler<unknown> {
  const built = deps.mailService ? undefined : buildMailServiceForWorker({ db: deps.db, env: deps.env });
  const mailService = deps.mailService ?? built!.mail;
  const outboxStore = deps.outboxStore ?? built?.outboxStore;

  return async (job) => {
    const parsed = MailRetryJobPayloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      await recordMailRetryEvent(deps.db, {
        action: 'mail_retry.malformed_payload',
        orgId: job.orgId,
        // Sin `messageKey` fiable (el payload ni siquiera pasó la
        // validación), se usa `job.id` como identificador de este evento
        // de auditoría -- no hay un identificador de negocio disponible.
        messageKey: job.id,
        jobId: job.id,
        after: { issues: parsed.error.issues, detail },
      });
      throw new MailRetryPermanentError(`mail_retry: payload malformado -- ${detail}`);
    }

    const payload = parsed.data;
    const preferences = (payload.preferences ?? undefined) as NotificationPreferences | undefined;

    // REQ-188 (0087, `app.mail_outbox_reopen_for_retry`): una `messageKey`
    // que llegó a este job SIEMPRE está `dead` en `mail_outbox` (es la
    // ÚNICA condición bajo la que `apps/api` encola `mail_retry`, ver
    // `send-transactional.ts`: `if (outcome.status === 'dead')`) -- y
    // ninguna función de 0080 puede des-marcar un estado `dead` por sí
    // sola. Sin este paso, `mailService.send()` de abajo vería `reserve()`
    // fallar para siempre y devolvería `dead` de nuevo SIN volver a tocar
    // el proveedor, en cada intento del job, sin importar cuántos queden.
    // No-op seguro si la fila ya no está `dead` (`sent` por una carrera con
    // otro proceso, `failed_permanent`, o no existe todavía).
    await outboxStore?.reopenDeadForRetry(payload.messageKey);

    let outcome: SendOutcome;
    try {
      outcome = await mailService.send({
        to: payload.to,
        templateId: payload.templateId,
        variables: payload.variables,
        messageKey: payload.messageKey,
        preferences,
        fromLocalPart: payload.fromLocalPart ?? undefined,
      });
    } catch (error) {
      // `MailService.send()` no debería lanzar salvo un error de
      // programación (p.ej. `templateId` que no existe en el catálogo,
      // `requireTemplate` -- ver packages/mail/src/templates/registry.ts) o
      // un fallo real de infraestructura al hablar con `mail_outbox`/
      // `mail_suppressions`. Lo primero es permanente (reintentar no
      // inventará una plantilla); lo segundo es transitorio.
      const message = error instanceof Error ? error.message : String(error);
      if (/No existe la plantilla de correo/.test(message)) {
        await recordMailRetryEvent(deps.db, {
          action: 'mail_retry.dead_permanent',
          orgId: job.orgId,
          messageKey: payload.messageKey,
          jobId: job.id,
          after: { detail: message },
        });
        throw new MailRetryPermanentError(`mail_retry: ${message}`);
      }
      throw error;
    }

    switch (outcome.status) {
      case 'sent':
        await recordMailRetryEvent(deps.db, {
          action: 'mail_retry.sent',
          orgId: job.orgId,
          messageKey: payload.messageKey,
          jobId: job.id,
          after: { templateId: payload.templateId, providerMessageId: outcome.providerMessageId },
        });
        return;

      case 'already_sent':
        await recordMailRetryEvent(deps.db, {
          action: 'mail_retry.already_sent',
          orgId: job.orgId,
          messageKey: payload.messageKey,
          jobId: job.id,
          after: { templateId: payload.templateId, providerMessageId: outcome.providerMessageId ?? null },
        });
        return;

      case 'skipped_preferences':
        await recordMailRetryEvent(deps.db, {
          action: 'mail_retry.skipped_preferences',
          orgId: job.orgId,
          messageKey: payload.messageKey,
          jobId: job.id,
          after: { templateId: payload.templateId },
        });
        return;

      case 'skipped_suppressed':
        await recordMailRetryEvent(deps.db, {
          action: 'mail_retry.suppressed',
          orgId: job.orgId,
          messageKey: payload.messageKey,
          jobId: job.id,
          after: { templateId: payload.templateId },
        });
        return;

      case 'not_configured':
        // Estado declarado (ausencia de credenciales), no un fallo de red
        // (packages/mail/src/provider/factory.ts) -- transitorio: se
        // reintenta con el backoff genérico de JobQueue hasta que exista un
        // proveedor real configurado.
        throw new Error(
          `mail_retry: MailProvider no configurado (sin credenciales) para templateId=${payload.templateId}, messageKey=${payload.messageKey}`,
        );

      case 'invalid_variables':
      case 'unregistered_recipient':
      case 'failed_permanent': {
        const detail = outcomeDetail(outcome);
        await recordMailRetryEvent(deps.db, {
          action: 'mail_retry.dead_permanent',
          orgId: job.orgId,
          messageKey: payload.messageKey,
          jobId: job.id,
          after: { templateId: payload.templateId, status: outcome.status, detail },
        });
        throw new MailRetryPermanentError(`mail_retry: fallo permanente (${outcome.status}): ${detail}`);
      }

      case 'dead': {
        const isFinalAttempt = job.attempts >= job.maxAttempts;
        if (isFinalAttempt) {
          await recordMailRetryEvent(deps.db, {
            action: 'mail_retry.dead',
            orgId: job.orgId,
            messageKey: payload.messageKey,
            jobId: job.id,
            after: { templateId: payload.templateId, detail: outcome.detail, attempts: job.attempts, maxAttempts: job.maxAttempts },
          });
        }
        throw new Error(
          `mail_retry: MailService agotó sus reintentos internos en este intento (${outcome.detail}); job.attempts=${job.attempts}/${job.maxAttempts}`,
        );
      }
    }
  };
}
