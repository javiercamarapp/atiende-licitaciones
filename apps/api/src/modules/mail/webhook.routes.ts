import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  applyMailWebhookEvent,
  parseResendWebhookPayload,
  verifyResendWebhookSignatureWithReplayGuard,
} from '@atiende/mail';
import { AppError, UnauthorizedError, ConflictError } from '../../lib/errors.js';
import { PgSuppressionStore } from '../../lib/mail/pg-suppression-store.js';
import { PgWebhookReplayGuard } from '../../lib/mail/pg-webhook-replay-guard.js';
import { PgOutboxLookup, isCoherentOutboxEvent } from '../../lib/mail/pg-outbox-lookup.js';

/**
 * REQ-181..195: webhook de entrega/rebote/queja del proveedor de correo
 * (`POST /webhooks/mail/resend`). Un rebote duro o una queja de spam
 * SUPRIME la dirección automáticamente (`applyMailWebhookEvent` →
 * `mail_suppressions`), y a partir de ahí `MailService` deja de escribirle:
 * seguir mandando correo a una dirección que ya rebotó es la forma más
 * rápida de quemar la reputación del dominio remitente.
 *
 * Todo lo que entra por aquí viene de INTERNET SIN AUTENTICAR, así que el
 * orden de las comprobaciones es la seguridad de esta ruta:
 *
 *  1. **Sin secreto configurado -> 503, nunca se procesa.** Falla CERRADO,
 *     igual que `requirePlatformApiKey`: no tener `RESEND_WEBHOOK_SECRET`
 *     no puede significar "acepta cualquier cosa" (eso convertiría este
 *     endpoint en una API pública para suprimir el correo de cualquier
 *     usuario -- una denegación de servicio trivial contra cuentas ajenas).
 *  2. **Firma Svix sobre el cuerpo CRUDO.** Por eso este plugin registra su
 *     propio parser de `application/json` que entrega el texto tal cual: un
 *     `JSON.parse` + re-serializado cambiaría un espacio y la firma dejaría
 *     de coincidir. El parser es ENCAPSULADO (solo este plugin), el resto
 *     de la API conserva el parser normal de Fastify.
 *  3. **Guardia de replay por `svix-id`** (ML-05, `PgWebhookReplayGuard`
 *     sobre `mail_webhook_events_seen`): una firma válida capturada se
 *     puede reenviar tal cual dentro de la ventana de tolerancia de 300s y
 *     volvería a verificar. La segunda vez responde 409 y NO reaplica nada.
 *  4. **AM-03 (docs/auditoria-2/api-mail.md, ALTA): coherencia contra
 *     `mail_outbox`.** Una firma Svix válida prueba que el payload lo mandó
 *     Resend -- NUNCA que el `email_id`/destinatario que trae dentro
 *     corresponda a un envío real de este entorno. Antes de este chequeo,
 *     CUALQUIERA con acceso al panel de Resend (o al secreto del webhook)
 *     podía suprimir PERMANENTEMENTE el correo de cualquier dirección --
 *     incluida la de seguridad de un usuario real -- sin haberle mandado
 *     nunca nada. `isCoherentOutboxEvent` (`lib/mail/pg-outbox-lookup.ts`)
 *     exige `providerMessageId` presente y que su fila en `mail_outbox`
 *     tenga ese MISMO destinatario; si no, el evento se acepta (202, el
 *     proveedor no debe reintentar) pero se IGNORA -- sin ningún efecto de
 *     negocio -- y queda un rastro en `audit_log` (`entity = 'mail_webhook'`,
 *     `action = 'mail.webhook_event_ignored'`) para poder auditar intentos
 *     de supresión que no corresponden a ningún envío nuestro.
 *  5. Solo entonces se traduce el payload y se aplica el efecto.
 */

const providerParamsSchema = z.object({ provider: z.enum(['resend']) });

export async function mailWebhookRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // Cuerpo CRUDO (ver punto 2 del docstring). Encapsulado en este plugin.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  const suppressionStore = new PgSuppressionStore(app.db);
  const replayGuard = new PgWebhookReplayGuard(app.db);
  const outboxLookup = new PgOutboxLookup(app.db);

  server.post(
    '/:provider',
    {
      schema: {
        params: providerParamsSchema,
        response: { 202: z.object({ processed: z.boolean(), type: z.string().nullable() }) },
      },
    },
    async (request, reply) => {
      reply.code(202);
      const secret = app.config.mailWebhookSecret;
      if (!secret) {
        throw new AppError(
          503,
          'https://atiende.example/errors/mail-webhook-not-configured',
          'El webhook de correo no está configurado (falta RESEND_WEBHOOK_SECRET).'
        );
      }

      const rawBody = typeof request.body === 'string' ? request.body : '';
      const headers = {
        svixId: headerValue(request.headers['svix-id']),
        svixTimestamp: headerValue(request.headers['svix-timestamp']),
        svixSignature: headerValue(request.headers['svix-signature']),
      };

      const verification = await verifyResendWebhookSignatureWithReplayGuard(rawBody, headers, secret, replayGuard);
      if (!verification.ok) {
        if (verification.reason === 'replay') {
          // Reenvío exacto de una petición ya procesada: 409 y NADA de
          // efecto de negocio (ver packages/mail README §Anti-replay).
          throw new ConflictError('Este evento de webhook ya se había procesado');
        }
        // Firma inválida, cabeceras incompletas, secreto mal formado o
        // timestamp fuera de rango: un solo 401 sin decir cuál de los
        // cuatro -- quien manda un webhook forjado no necesita pistas.
        app.log.warn({ motivo: verification.reason, provider: request.params.provider }, 'Webhook de correo rechazado');
        throw new UnauthorizedError('Firma de webhook inválida');
      }

      let json: unknown;
      try {
        json = JSON.parse(rawBody) as unknown;
      } catch {
        json = null;
      }
      const event = parseResendWebhookPayload(json);
      if (!event) {
        // Firma válida pero un evento que este catálogo no modela (Resend
        // manda más de cinco tipos) o un payload incompleto: se acepta y se
        // ignora -- devolver un error haría que el proveedor reintentara en
        // bucle algo que nunca vamos a procesar.
        return { processed: false, type: null };
      }

      // AM-03: solo los tipos que producen un efecto de negocio
      // (bounce/complaint) necesitan corresponder a un envío real -- los
      // informativos (sent/delivered/delivery_delayed) ya son inocuos por sí
      // mismos (`applyMailWebhookEvent` no hace nada con ellos).
      if (event.type === 'email.bounced' || event.type === 'email.complained') {
        const coherence = await isCoherentOutboxEvent(outboxLookup, event);
        if (!coherence.coherent) {
          app.log.warn(
            { motivo: coherence.reason, tipo: event.type, provider: request.params.provider },
            'Webhook de correo aceptado pero IGNORADO: no corresponde a ningún envío real de este entorno (AM-03)'
          );
          await recordIgnoredWebhookEvent(app, { reason: coherence.reason, event, requestId: request.id, correlationId: request.correlationId });
          return { processed: false, type: event.type };
        }
      }

      await applyMailWebhookEvent(event, suppressionStore, `webhook:${request.params.provider}`);
      return { processed: true, type: event.type };
    }
  );
}

function headerValue(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

/**
 * AM-03: deja rastro en `audit_log` de un evento de webhook con firma
 * válida que se descartó por no corresponder a ningún envío real -- para
 * poder distinguir en retrospectiva "nadie nos manda tráfico raro" de
 * "alguien intenta suprimir direcciones que nunca les mandamos nada".
 *
 * Este endpoint no tiene sesión (llega sin autenticar de Internet, ver
 * docstring del módulo): un `recordAudit` normal fallaría por RLS
 * (`ins_audit_log`, 0008, exige superadmin o membresía de organización) --
 * mismo motivo por el que `recordAuthAudit` necesita la función SECURITY
 * DEFINER `app.record_auth_event` (API-13). Añadir un análogo
 * `app.record_mail_webhook_event` es un cambio de `packages/db`, fuera del
 * ámbito asignado a esta ronda (ver docs/logs/fix-api-mail.log); mientras
 * tanto, este INSERT usa `db.query` DIRECTO (sin `set local role
 * app_role`), la MISMA excepción documentada y acotada que
 * `lib/mail/pg-outbox-lookup.ts` ya usa para la lectura de `mail_outbox` --
 * `org_id`/`actor_id` van NULL (evento de plataforma, sin sesión ni
 * organización, igual que cualquier auditoría de `auth.*` anónima) y el
 * `after` nunca lleva más que metadatos ya públicos en el propio payload
 * del webhook (tipo de evento, motivo, la dirección de correo).
 */
async function recordIgnoredWebhookEvent(
  app: FastifyInstance,
  params: {
    reason: 'sin_provider_message_id' | 'sin_envio_correspondiente';
    event: { type: string; email: string; providerMessageId?: string };
    requestId: string;
    correlationId?: string | null;
  }
): Promise<void> {
  try {
    await app.db.query(
      `insert into audit_log (org_id, actor_id, action, entity, entity_id, after, request_id, correlation_id)
       values (null, null, 'mail.webhook_event_ignored', 'mail_webhook', $1, $2::jsonb, $3, $4)`,
      [
        params.event.providerMessageId ?? null,
        JSON.stringify({ reason: params.reason, type: params.event.type, email: params.event.email }),
        params.requestId,
        params.correlationId ?? null,
      ]
    );
  } catch (err) {
    // Best-effort, mismo criterio que `auditGoogleRejected`
    // (modules/auth/google/routes.ts): un fallo al auditar nunca debe
    // convertir en 500 una respuesta que ya decidimos que es 202/processed:false.
    app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'No se pudo registrar el evento de webhook ignorado en audit_log');
  }
}
