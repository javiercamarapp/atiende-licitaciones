import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hashPassword } from '../../lib/passwords.js';
import { BadRequestError } from '../../lib/errors.js';
import { recordAuthAudit } from '../../lib/audit.js';
import { verifySignedMailParams } from '../../lib/mail/links.js';
import { fireAndForgetMail } from '../../lib/mail/pending.js';
import { sendEmailVerification, sendPasswordResetEmail } from '../../lib/mail/triggers.js';
import { auditContext } from './routes.js';

/**
 * REQ-181..195 (+ paridad Ronda G, recuperación de contraseña): las cuatro
 * rutas ANÓNIMAS que cierran los flujos de correo de cuenta.
 *
 * Tres reglas duras se repiten en todas y valen la pena decirlas una vez:
 *
 * 1. **Ninguna revela si una cuenta existe.** `/email/resend-verification`
 *    y `/password/forgot` responden EXACTAMENTE lo mismo (202 + el mismo
 *    cuerpo) exista o no la dirección, y el envío se dispara sin `await`
 *    (`fireAndForgetMail`) para que tampoco la LATENCIA distinga los dos
 *    casos -- el mismo criterio con el que API-03 cerró el oráculo de
 *    temporización de `/auth/login` y `/auth/register`.
 *
 * 2. **El enlace firmado no basta: el token de un solo uso manda.** La
 *    firma HMAC (`verifySignedMailParams`) solo garantiza que el payload no
 *    se manipuló y que el enlace no venció; quien decide de verdad es el
 *    consumo ATÓMICO del token hasheado en la base
 *    (`app.consume_email_verification_token`/`app.reset_password_with_token`,
 *    migración 0084): un `UPDATE ... WHERE consumed_at IS NULL AND
 *    expires_at > now() RETURNING` que, bajo concurrencia, como mucho una
 *    petición gana. Un enlace válido REUTILIZADO falla ahí, no en la firma.
 *
 * 3. **El token en claro nunca se guarda.** En la base solo vive
 *    `sha256(token)` (`hashToken` de `lib/mail/triggers.ts`); el valor en
 *    claro existe únicamente dentro del correo.
 */

const signedParamsSchema = z.object({
  /** Payload firmado (base64url) tal cual venía en el enlace del correo. */
  d: z.string().min(1).max(4096),
  /** Firma HMAC-SHA256 (base64url) del enlace. */
  s: z.string().min(1).max(512),
});

const emailBodySchema = z.object({ email: z.string().email() });

const okSchema = z.object({ ok: z.literal(true) });

/**
 * Respuesta ÚNICA de los dos endpoints que aceptan un correo arbitrario.
 * Deliberadamente sin ningún campo que dependa de si la cuenta existe.
 */
const ACCEPTED_BODY = { ok: true } as const;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Mensaje ÚNICO para cualquier fallo de enlace: inválido, vencido, ya usado o de otra cuenta. */
function invalidLinkError(): BadRequestError {
  return new BadRequestError('El enlace no es válido o ya venció. Solicita uno nuevo.');
}

export async function authMailRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const authTier = app.rateLimitSettings.auth;

  // ---------------------------------------------------------------------
  // Verificación de correo
  // ---------------------------------------------------------------------
  server.post(
    '/email/verify',
    {
      config: { rateLimit: { max: authTier.max, timeWindow: authTier.timeWindow } },
      schema: { body: signedParamsSchema, response: { 200: z.object({ verified: z.literal(true) }) } },
    },
    async (request) => {
      const payload = verifySignedMailParams<{ verificationId?: string; token?: string }>(app, '/verificar-correo', request.body);
      if (!payload || typeof payload.token !== 'string') throw invalidLinkError();

      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        return tx.query<{ out_user_id: string }>('select * from app.consume_email_verification_token($1)', [hashToken(payload.token!)]);
      });
      const userId = rows[0]?.out_user_id;
      // Token ya consumido, vencido, o de una cuenta borrada: un solo
      // mensaje, sin distinguir cuál de los tres (regla 2 del docstring).
      if (!userId) throw invalidLinkError();

      await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        // `auth.email_verified` SÍ exige actor coincidente en
        // `app.record_auth_event` (0084): la identidad quedó probada por el
        // consumo atómico del token, así que se fija a ESE user_id -- nunca
        // a un valor que venga de la petición.
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        await recordAuthAudit(tx, {
          actorId: userId,
          action: 'auth.email_verified',
          after: auditContext(request),
          requestId: request.id,
        });
      });

      return { verified: true } as const;
    }
  );

  server.post(
    '/email/resend-verification',
    {
      // Mismo tier anti-fuerza-bruta que `/auth/login`: sin él, este
      // endpoint sería una forma barata de mandar correo a terceros en
      // volumen (o de enumerar cuentas por otros canales, p.ej. rebotes).
      config: { rateLimit: { max: authTier.max, timeWindow: authTier.timeWindow } },
      schema: { body: emailBodySchema, response: { 202: okSchema } },
    },
    async (request, reply) => {
      const { email } = request.body;
      const user = await findUserForMail(app, email);

      // Solo se manda si la cuenta existe, sigue activa, tiene contraseña
      // propia (una cuenta solo-Google ya llega verificada por Google,
      // REQ-179) y todavía NO está verificada -- reenviar a una cuenta ya
      // verificada solo daría un token vivo de más sin ningún beneficio.
      if (user && user.is_active && user.password_hash && user.email_verified_at === null) {
        fireAndForgetMail(app, 'email-verification', async () => {
          await sendEmailVerification(app, { id: user.id, email, fullName: null });
          await app.db.transaction(async (tx) => {
            await tx.query('set local role app_role');
            await recordAuthAudit(tx, {
              actorId: user.id,
              action: 'auth.email_verification_sent',
              after: { reenvio: true, ...auditContext(request) },
              requestId: request.id,
            });
          });
        });
      }

      reply.code(202);
      return ACCEPTED_BODY;
    }
  );

  // ---------------------------------------------------------------------
  // Recuperación de contraseña
  // ---------------------------------------------------------------------
  server.post(
    '/password/forgot',
    {
      config: { rateLimit: { max: authTier.max, timeWindow: authTier.timeWindow } },
      schema: { body: emailBodySchema, response: { 202: okSchema } },
    },
    async (request, reply) => {
      const { email } = request.body;
      const user = await findUserForMail(app, email);

      // Una cuenta creada SOLO con Google (`password_hash is null`) no tiene
      // contraseña que restablecer: darle un enlace de restablecimiento
      // crearía una contraseña que nadie pidió y convertiría la cuenta en
      // una de acceso mixto por la puerta de atrás. Se omite el envío --
      // sin que la respuesta cambie ni un byte.
      if (user && user.is_active && user.password_hash) {
        fireAndForgetMail(app, 'password-reset', async () => {
          await sendPasswordResetEmail(app, { id: user.id, email, fullName: null }, request.ip);
          await app.db.transaction(async (tx) => {
            await tx.query('set local role app_role');
            await recordAuthAudit(tx, {
              actorId: user.id,
              action: 'auth.password_reset_requested',
              after: auditContext(request),
              requestId: request.id,
            });
          });
        });
      }

      reply.code(202);
      return ACCEPTED_BODY;
    }
  );

  server.post(
    '/password/reset',
    {
      config: { rateLimit: { max: authTier.max, timeWindow: authTier.timeWindow } },
      schema: {
        body: signedParamsSchema.extend({ newPassword: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres') }),
        response: { 200: okSchema },
      },
    },
    async (request) => {
      const payload = verifySignedMailParams<{ resetId?: string; token?: string }>(app, '/restablecer-contrasena', {
        d: request.body.d,
        s: request.body.s,
      });
      if (!payload || typeof payload.token !== 'string') throw invalidLinkError();

      const newHash = await hashPassword(request.body.newPassword);
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        // Cambia la contraseña Y revoca TODAS las sesiones (familia de
        // refresh tokens completa) en la MISMA función SECURITY DEFINER
        // (0084): quien pudo haber entrado con la contraseña vieja -- el
        // motivo típico para restablecerla -- queda fuera en el mismo acto,
        // no en un segundo paso que pueda fallar por separado.
        return tx.query<{ out_user_id: string }>('select * from app.reset_password_with_token($1, $2)', [
          hashToken(payload.token!),
          newHash,
        ]);
      });
      const userId = rows[0]?.out_user_id;
      if (!userId) throw invalidLinkError();

      await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        await recordAuthAudit(tx, {
          actorId: userId,
          action: 'auth.password_reset_completed',
          after: auditContext(request),
          requestId: request.id,
        });
      });

      return ACCEPTED_BODY;
    }
  );
}

interface UserForMail {
  id: string;
  password_hash: string | null;
  is_active: boolean;
  email_verified_at: string | null;
}

/**
 * `app.find_user_by_email` (0010, ampliada en 0085) es la ÚNICA función que
 * expone datos de `users` en contexto pre-sesión, y solo se deja ejecutar
 * si `app.current_user_id()` NO está fijado (candado DB-01 de 0019) -- por
 * eso estas rutas son anónimas por construcción, no por olvido.
 */
async function findUserForMail(app: FastifyInstance, email: string): Promise<UserForMail | undefined> {
  const { rows } = await app.db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    return tx.query<UserForMail>('select * from app.find_user_by_email($1)', [email]);
  });
  return rows[0];
}
