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
 *  4. Solo entonces se traduce el payload y se aplica el efecto.
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

      await applyMailWebhookEvent(event, suppressionStore, `webhook:${request.params.provider}`);
      return { processed: true, type: event.type };
    }
  );
}

function headerValue(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}
