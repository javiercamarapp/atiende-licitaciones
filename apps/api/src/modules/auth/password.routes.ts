import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { hashPassword, verifyPassword } from '../../lib/passwords.js';
import { ConflictError, UnauthorizedError } from '../../lib/errors.js';
import { recordAuthAudit } from '../../lib/audit.js';
import { assertStepUpOrgId, requireStepUp } from '../../lib/step-up.js';
import { auditContext } from './routes.js';
import { changePasswordBodySchema, changePasswordResponseSchema } from './schemas.js';

/**
 * E21 (docs/BACKLOG.md, migración 0092): `POST /auth/password/change` --
 * cambiar la contraseña de la propia cuenta ESTANDO YA AUTENTICADO (distinto
 * de `POST /auth/password/reset`, que recupera el acceso vía enlace de
 * correo cuando la contraseña se olvidó -- `modules/auth/mail.routes.ts`).
 *
 * Dos capas de verificación, no una sola:
 *  1. Step-up (2FA reciente, mismo `requireStepUp` que el resto de
 *     `apps/api`, purpose `auth.password_change`) -- igual que
 *     `POST /auth/2fa/disable` (E21, primera mitad), es un endpoint de
 *     USUARIO (sin `app.requireOrg`): el `X-Org-Id` que exige `requireStepUp`
 *     para emparejar la sesión es el mismo que se usó para PEDIR el
 *     `stepUpToken`, no una organización "dueña" de la acción.
 *  2. La contraseña ACTUAL, verificada de nuevo aquí mismo -- un
 *     `stepUpToken` robado (p.ej. de un dispositivo desbloqueado) no basta
 *     por sí solo para tomar la cuenta si el atacante no conoce también la
 *     contraseña vigente.
 *
 * Se valida la contraseña actual DESPUÉS de `requireStepUp` (nunca antes:
 * mismo criterio que `/2fa/disable` -- un rechazo de negocio no debe filtrar
 * información a quien no probó posesión del 2FA), y el `stepUpToken` se
 * consume igual aunque la contraseña actual resulte incorrecta (mismo
 * patrón que `/2fa/disable` con una cuenta sin otro método de acceso).
 *
 * Éxito: revoca TODAS las sesiones activas (misma función
 * `app.revoke_all_refresh_tokens` que ya usa `app.reset_password_with_token`
 * para el flujo de recuperación por correo) -- quien pudo tener una sesión
 * abierta con la contraseña vieja queda fuera en el mismo acto, este
 * dispositivo incluido (tendrá que volver a iniciar sesión con la
 * contraseña nueva, igual que tras un restablecimiento por correo).
 */
export async function authPasswordRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const authTier = app.rateLimitSettings.auth;

  server.post(
    '/password/change',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: authTier.max, timeWindow: authTier.timeWindow } },
      schema: { body: changePasswordBodySchema, response: { 200: changePasswordResponseSchema } },
    },
    async (request) => {
      const userId = request.userId!;
      const orgId = assertStepUpOrgId(request.headers['x-org-id']);
      const { currentPassword, newPassword } = request.body;

      const result = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

        await requireStepUp(tx, { userId, stepUpHeader: request.headers['x-step-up'], orgId, purpose: 'auth.password_change' });

        const userRow = await tx.query<{ password_hash: string | null }>('select password_hash from users where id = $1', [userId]);
        const currentHash = userRow.rows[0]?.password_hash ?? null;
        // Una cuenta solo-Google (REQ-172, `password_hash is null`) no
        // tiene contraseña que "cambiar" -- se rechaza DESPUÉS de
        // `requireStepUp` (mismo criterio del docstring de arriba), pero el
        // stepUpToken igual se consumió.
        if (currentHash === null) {
          return { kind: 'no_password' as const };
        }

        const valid = await verifyPassword(currentPassword, currentHash);
        if (!valid) {
          return { kind: 'invalid_current_password' as const };
        }

        const newHash = await hashPassword(newPassword);
        await tx.query('update users set password_hash = $1 where id = $2', [newHash, userId]);
        // Mismo cierre de sesiones que `app.reset_password_with_token`
        // (0084) tras un restablecimiento por correo -- ver docstring.
        await tx.query('select app.revoke_all_refresh_tokens($1)', [userId]);

        await recordAuthAudit(tx, { actorId: userId, action: 'auth.password_changed', after: auditContext(request), requestId: request.id });

        return { kind: 'ok' as const };
      });

      if (result.kind === 'no_password') {
        throw new ConflictError(
          'Esta cuenta no tiene una contraseña propia (solo Google, REQ-172) -- no hay contraseña que cambiar.'
        );
      }
      if (result.kind === 'invalid_current_password') {
        throw new UnauthorizedError('La contraseña actual no es correcta.');
      }
      return { changed: true as const };
    }
  );
}
