import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyHmacWebhookSignature, type WebhookReplayGuard } from '@atiende/webhooks';
import { AppError, ConflictError, UnauthorizedError } from '../errors.js';

/**
 * REQ-096: middleware/verificador HMAC GENÉRICO para cualquier webhook
 * entrante nuevo de `apps/api`. Antes de este archivo, el único webhook
 * entrante real del repo (`POST /webhooks/mail/:provider`, ver
 * `modules/mail/webhook.routes.ts`) tenía el flujo de comprobaciones
 * escrito a mano DENTRO del handler de la ruta:
 *
 *   1. Sin secreto configurado -> falla CERRADO (503) antes de intentar
 *      verificar nada -- no tener el secreto configurado no puede
 *      significar "acepta cualquier cosa".
 *   2. Firma HMAC sobre el cuerpo CRUDO, según el esquema del proveedor.
 *   3. Deduplicación por `event_id` contra un `WebhookReplayGuard` (si se
 *      configura uno) -> `409 Conflict` en un replay, SIN aplicar el
 *      efecto de negocio de nuevo.
 *
 * `createHmacWebhookGuard` generaliza exactamente ese flujo: un webhook
 * nuevo solo aporta su `HmacWebhookScheme` (qué cabeceras son obligatorias,
 * cómo se separan los candidatos de firma, cómo se decodifica el secreto —
 * ver `svix-scheme.ts` para el ejemplo real de Resend/Svix) y obtiene la
 * misma protección sin reescribir la parte delicada.
 *
 * Uso típico desde una ruta nueva:
 *
 *   const verify = createHmacWebhookGuard({
 *     scheme: createSvixScheme(),
 *     getSecret: () => app.config.miWebhookSecret,
 *     replayGuard: new PgWebhookReplayGuard(app.db, 'mi-proveedor'),
 *     notConfiguredMessage: 'El webhook de X no está configurado (falta X_WEBHOOK_SECRET).',
 *   });
 *
 *   registerRawBodyJsonParser(app); // dentro de un plugin encapsulado
 *   server.post('/mi-proveedor', async (request, reply) => {
 *     const rawBody = typeof request.body === 'string' ? request.body : '';
 *     const { eventId } = await verify(rawBody, request.headers);
 *     // ... aplicar el efecto de negocio ...
 *   });
 */

export interface ParsedWebhookHeaders {
  /** Identificador de esta entrega concreta, usado para deduplicar. */
  eventId: string;
  /** Timestamp del proveedor en segundos Unix, si el esquema lo trae. */
  timestampSeconds?: number;
  /** Candidatos de firma ya extraídos del header correspondiente, en la codificación del esquema. */
  signatureCandidates: string[];
}

export interface HmacWebhookScheme {
  encoding: 'hex' | 'base64';
  /** `null` si faltan cabeceras obligatorias -> se traduce a 401 (sin decir cuál, mismo criterio que el webhook de correo: quien manda una petición forjada no necesita pistas). */
  parseHeaders(headers: FastifyRequest['headers']): ParsedWebhookHeaders | null;
  /** Arma el contenido exacto que el proveedor firmó. */
  buildSignedContent(rawBody: string, eventId: string, timestampSeconds?: number): string;
  /** Decodifica el secreto de texto plano (variable de entorno) a la llave HMAC. `null` si el formato es inválido -> falla cerrado (503, mismo criterio que "sin secreto configurado"). */
  decodeSecret(secret: string): Buffer | null;
}

export interface HmacWebhookGuardOptions {
  scheme: HmacWebhookScheme;
  getSecret: () => string | undefined;
  /** Mensaje del 503 cuando falta el secreto o es inválido — debe nombrar la variable de entorno esperada. */
  notConfiguredMessage: string;
  /** Si se omite, se verifica la firma sin deduplicar por event_id. */
  replayGuard?: WebhookReplayGuard;
  toleranceSeconds?: number;
  now?: () => number;
}

export interface HmacWebhookGuardResult {
  eventId: string;
}

export type HmacWebhookVerifier = (rawBody: string, headers: FastifyRequest['headers']) => Promise<HmacWebhookGuardResult>;

export function createHmacWebhookGuard(options: HmacWebhookGuardOptions): HmacWebhookVerifier {
  return async function verify(rawBody, headers) {
    const secret = options.getSecret();
    if (!secret) {
      throw new AppError(503, 'https://atiende.example/errors/webhook-not-configured', options.notConfiguredMessage);
    }

    const parsed = options.scheme.parseHeaders(headers);
    if (!parsed) {
      throw new UnauthorizedError('Firma de webhook inválida');
    }

    const secretBytes = options.scheme.decodeSecret(secret);
    if (!secretBytes) {
      throw new AppError(503, 'https://atiende.example/errors/webhook-not-configured', options.notConfiguredMessage);
    }

    const result = await verifyHmacWebhookSignature({
      rawBody,
      eventId: parsed.eventId,
      timestampSeconds: parsed.timestampSeconds,
      signatureCandidates: parsed.signatureCandidates,
      secret: secretBytes,
      buildSignedContent: (body, id) => options.scheme.buildSignedContent(body, id, parsed.timestampSeconds),
      encoding: options.scheme.encoding,
      toleranceSeconds: options.toleranceSeconds,
      now: options.now,
      replayGuard: options.replayGuard,
    });

    if (!result.ok) {
      if (result.reason === 'replay') {
        throw new ConflictError('Este evento de webhook ya se había procesado');
      }
      // Firma inválida, timestamp fuera de rango: un solo 401 sin decir
      // cuál — quien manda un webhook forjado no necesita pistas (mismo
      // criterio que ya usaba `modules/mail/webhook.routes.ts`).
      throw new UnauthorizedError('Firma de webhook inválida');
    }

    return { eventId: parsed.eventId };
  };
}

/**
 * Registra un parser de `application/json` que entrega el cuerpo tal cual
 * (texto CRUDO) en vez de parsearlo — necesario para CUALQUIER
 * verificación HMAC sobre el cuerpo: un `JSON.parse` + re-serializado
 * invalida la firma por un solo espacio de diferencia. Llamar dentro de un
 * plugin/subapp ENCAPSULADO (nunca sobre `app` raíz, vía
 * `fastify.register` con su propio scope) para no afectar al parser normal
 * del resto de rutas — mismo patrón que ya usaba
 * `modules/mail/webhook.routes.ts`.
 */
export function registerRawBodyJsonParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });
}
