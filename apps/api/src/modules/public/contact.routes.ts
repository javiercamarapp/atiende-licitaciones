import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { fireAndForgetMail } from '../../lib/mail/pending.js';
import { sendContactReceivedEmail } from '../../lib/mail/triggers.js';

/**
 * Ampliación 2 §2: formulario de contacto público (`POST /public/contact`),
 * anónimo por definición -- es la puerta de entrada del embudo de
 * marketing, antes de que exista cuenta ni organización. Deja un registro en
 * `contact_requests` (0083) y manda un correo INTERNO al buzón del equipo
 * (`CONTACT_INBOX`, plantilla `contact-received`, categoría `internal`, que
 * ninguna preferencia de usuario puede filtrar).
 *
 * Anti-abuso en tres capas, porque un endpoint anónimo que MANDA CORREO es
 * exactamente lo que un spammer busca:
 *
 *  1. **Límite de tasa por IP** del tier `auth` (el más estricto de la API,
 *     5/min por defecto) -- no el `global` de 300/min, que dejaría meter
 *     cientos de mensajes por minuto desde una sola IP.
 *  2. **Honeypot** (`website`): un campo que el formulario real pinta
 *     oculto y ninguna persona llena. Si viene con algo, la petición se
 *     descarta EN SILENCIO -- misma respuesta 202, mismo cuerpo, sin
 *     registro ni correo. Decirle "detectamos un bot" a un bot solo le
 *     enseña a evitar el campo la próxima vez.
 *  3. **Longitudes acotadas en el esquema** (nombre, correo, empresa,
 *     mensaje): un mensaje de 2 MB no es un contacto, y el cuerpo del
 *     correo interno se arma con ese texto.
 *
 * El envío va sin `await` (`fireAndForgetMail`): un fallo del proveedor de
 * correo nunca debe perder el registro en base -- el mensaje ya quedó
 * guardado y consultable desde el back office aunque el aviso interno no
 * salga.
 */

const contactBodySchema = z.object({
  name: z.string().trim().min(2, 'El nombre es obligatorio').max(120),
  email: z.string().email().max(254),
  company: z.string().trim().max(160).optional(),
  message: z.string().trim().min(10, 'Cuéntanos un poco más').max(4000),
  /** Honeypot: SIEMPRE vacío en una petición legítima -- ver capa 2 del docstring. */
  website: z.string().max(200).optional(),
});

export async function publicContactRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const tier = app.rateLimitSettings.auth;

  server.post(
    '/contact',
    {
      config: { rateLimit: { max: tier.max, timeWindow: tier.timeWindow } },
      schema: { body: contactBodySchema, response: { 202: z.object({ ok: z.literal(true) }) } },
    },
    async (request, reply) => {
      reply.code(202);
      const { name, email, company, message, website } = request.body;

      // Capa 2: honeypot lleno -> se descarta sin dejar rastro visible para
      // quien lo mandó (mismo 202 que un envío legítimo).
      if (website && website.trim().length > 0) {
        app.log.warn({ ip: request.ip }, 'Contacto público descartado por honeypot');
        return { ok: true } as const;
      }

      const id = randomUUID();
      const userAgent = request.headers['user-agent'];
      await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query(
          `insert into contact_requests (id, name, email, company, message, ip, user_agent)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [id, name, email, company ?? null, message, request.ip, Array.isArray(userAgent) ? (userAgent[0] ?? null) : (userAgent ?? null)]
        );
      });

      fireAndForgetMail(app, 'contact-received', () =>
        sendContactReceivedEmail(app, { id, name, email, message, source: 'formulario_contacto' })
      );

      return { ok: true } as const;
    }
  );
}
