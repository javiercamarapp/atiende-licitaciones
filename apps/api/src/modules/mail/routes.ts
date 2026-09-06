import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BadRequestError } from '../../lib/errors.js';
import { verifySignedMailParams } from '../../lib/mail/links.js';
import {
  isOptionalCategory,
  readNotificationPreferences,
  setNotificationPreferences,
  type OptionalCategory,
} from '../../lib/mail/preferences.js';

/**
 * REQ-181..195: centro de preferencias de notificación + baja de un clic
 * (RFC 8058).
 *
 * `POST /mail/unsubscribe` es el endpoint que el BOTÓN NATIVO "Cancelar
 * suscripción" de Gmail/Yahoo invoca, sin ninguna interacción humana más
 * (es lo que `List-Unsubscribe-Post: List-Unsubscribe=One-Click` promete, y
 * lo que `MailService` ya anuncia en las cabeceras de toda plantilla
 * opcional -- ver packages/mail/README.md §ML-02). De ahí sus tres rarezas
 * frente al resto de esta API, todas exigidas por el RFC:
 *
 *  - **Sin sesión.** Quien hace el POST es el servidor de correo del
 *    destinatario, no un navegador con `Authorization`. La identidad sale
 *    de la firma HMAC del propio enlace (`userId` dentro del payload
 *    firmado), verificada aquí -- nunca de un parámetro crudo.
 *  - **Cuerpo `application/x-www-form-urlencoded`** (`List-Unsubscribe=One-Click`),
 *    que esta API no acepta en ninguna otra ruta. Se registra un parser
 *    ENCAPSULADO en este plugin (no global) que lo descarta: el contenido
 *    del cuerpo no decide nada, solo el enlace firmado.
 *  - **Respuesta 200 vacía, nunca una redirección ni HTML.** Un cliente de
 *    correo hace la petición en segundo plano; no hay nadie mirando una
 *    página.
 */

const preferencesSchema = z.object({
  tenderMatches: z.boolean(),
  tenderChanges: z.boolean(),
  approvals: z.boolean(),
  submission: z.boolean(),
  deadlines: z.boolean(),
  documentExpiration: z.boolean(),
  postAward: z.boolean(),
  weeklySummary: z.boolean(),
});

const updatePreferencesSchema = preferencesSchema.partial().refine((v) => Object.keys(v).length > 0, {
  message: 'Envía al menos una categoría',
});

const unsubscribeQuerySchema = z.object({
  d: z.string().min(1).max(4096),
  s: z.string().min(1).max(512),
});

export async function mailRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // Parser ENCAPSULADO (solo dentro de este plugin, nunca global): el POST
  // de un clic llega como `application/x-www-form-urlencoded` con
  // `List-Unsubscribe=One-Click`. El contenido se descarta a propósito --
  // aceptarlo como dato de entrada sería confiar en algo que el enlace
  // firmado ya decide por completo.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, _body, done) => {
    done(null, {});
  });

  // ---------------------------------------------------------------------
  // Baja de un clic (RFC 8058) -- anónima, autenticada por la firma del enlace
  // ---------------------------------------------------------------------
  server.post(
    '/unsubscribe',
    { schema: { querystring: unsubscribeQuerySchema, response: { 200: z.object({ ok: z.literal(true) }) } } },
    async (request) => {
      const { userId, category } = resolveUnsubscribeLink(app, request.query);
      await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        // SECURITY DEFINER (0082): el `userId` viene YA verificado por la
        // firma HMAC del enlace; sin sesión no hay `app.current_user_id()`
        // que satisfaga la política RLS normal de la tabla.
        await tx.query('select app.set_notification_preference_unsigned($1, $2, false)', [userId, category]);
      });
      return { ok: true } as const;
    }
  );

  // Un enlace de baja también se puede abrir a mano en un navegador (el que
  // pinta `EmailLayout` en el pie del correo). Ese GET NO aplica la baja:
  // solo dice si el enlace sigue siendo válido, para que `apps/web` muestre
  // una confirmación explícita antes del POST. Un GET que cambiara estado
  // se dispararía solo con que un escáner de enlaces del propio proveedor
  // de correo lo visitara.
  server.get(
    '/unsubscribe',
    {
      schema: {
        querystring: unsubscribeQuerySchema,
        response: { 200: z.object({ valid: z.literal(true), category: z.string().nullable() }) },
      },
    },
    async (request) => {
      const { category } = resolveUnsubscribeLink(app, request.query);
      return { valid: true, category } as const;
    }
  );

  // ---------------------------------------------------------------------
  // Centro de preferencias (con sesión)
  // ---------------------------------------------------------------------
  server.get(
    '/preferences',
    { preHandler: [app.authenticate], schema: { response: { 200: preferencesSchema } } },
    async (request) => readNotificationPreferences(app, request.userId!)
  );

  server.put(
    '/preferences',
    {
      preHandler: [app.authenticate],
      schema: { body: updatePreferencesSchema, response: { 200: preferencesSchema } },
    },
    async (request) => {
      const userId = request.userId!;
      // El usuario solo puede tocar SUS preferencias: el `userId` sale del
      // access token verificado, nunca del cuerpo (no hay forma de nombrar a
      // otra persona en esta petición).
      await setNotificationPreferences(app, userId, request.body);
      return readNotificationPreferences(app, userId);
    }
  );
}

/**
 * Verifica el enlace firmado de baja y devuelve a quién pertenece y qué
 * categoría apaga (`null` = todas las opcionales). Un enlace inválido,
 * vencido o con una categoría desconocida da el MISMO 400 -- nunca se
 * distingue el motivo (ver `modules/auth/mail.routes.ts`, regla 1).
 */
function resolveUnsubscribeLink(
  app: FastifyInstance,
  query: { d: string; s: string }
): { userId: string; category: OptionalCategory | null } {
  const payload = verifySignedMailParams<{ userId?: string; category?: string | null }>(app, '/preferencias/baja', query);
  if (!payload || typeof payload.userId !== 'string' || payload.userId.length === 0) {
    throw new BadRequestError('El enlace de baja no es válido o ya venció.');
  }
  const raw = payload.category;
  if (raw === null || raw === undefined) return { userId: payload.userId, category: null };
  if (!isOptionalCategory(raw)) {
    // Una categoría desconocida (o una OBLIGATORIA, que no se puede apagar)
    // se trata como enlace inválido -- nunca como "apaga todo".
    throw new BadRequestError('El enlace de baja no es válido o ya venció.');
  }
  return { userId: payload.userId, category: raw };
}

