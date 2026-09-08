/**
 * E19/E21 (docs/BACKLOG.md): `POST /auth/google/unlink` -- desvincula la
 * identidad de Google de la cuenta PROPIA (ya autenticada). Espejo, en
 * sentido inverso, de la vinculación automática que ocurre en
 * `resolveGoogleIdentityOnce` (`modules/auth/google/routes.ts`): borra la
 * fila de `user_identities (user_id, provider='google')`.
 *
 * Guardas, en este orden -- TODAS después de `requireStepUp` (nunca antes:
 * mismo criterio que `/2fa/disable` -- ni siquiera "esta cuenta no tiene
 * Google vinculado" debe filtrarse a quien no probó posesión del 2FA):
 *  1. Step-up (2FA reciente, mismo `requireStepUp` que el resto de
 *     `apps/api`, purpose `auth.google_unlink`) -- igual que
 *     `POST /auth/2fa/disable` (E21) y `POST /auth/password/change` (E21),
 *     es un endpoint de USUARIO (sin `app.requireOrg`): el `X-Org-Id` que
 *     exige `requireStepUp` para emparejar la sesión es el mismo que se
 *     usó para PEDIR el `stepUpToken`, no una organización "dueña" de la
 *     acción -- no existe tal cosa para una identidad de proveedor OIDC,
 *     que es de cuenta.
 *  2. ¿Existe siquiera una identidad de Google vinculada? Si no, 404 --
 *     nada que desvincular.
 *  3. Regla de negocio explícita (E19, docs/BACKLOG.md): NUNCA dejar la
 *     cuenta sin ningún método de acceso -- desvincular Google solo es
 *     seguro si la cuenta conserva una contraseña propia
 *     (`users.password_hash`). Una cuenta creada vía Google (REQ-174) nunca
 *     tuvo contraseña (`password_hash is null` desde el alta) -- para esa
 *     cuenta, desvincular dejaría CERO métodos de acceso, así que se
 *     rechaza con 409 hasta que el usuario configure una contraseña
 *     primero (`POST /auth/password/forgot` -- el flujo de "olvidé mi
 *     contraseña" es también el único camino para PONER una por primera
 *     vez en una cuenta que nunca tuvo una).
 *
 * Se comprueba la regla de negocio (3) DESPUÉS de `requireStepUp` (mismo
 * criterio que `/2fa/disable`: un rechazo de negocio no debe filtrar
 * información a quien no probó posesión del 2FA); el `stepUpToken` se
 * consume igual aunque se rechace -- mismo patrón que `/2fa/disable`/
 * `/password/change` con una cuenta sin otro método de acceso: se devuelve
 * un marcador y se lanza el error FUERA de la transacción, así el consumo
 * del step-up sí se confirma.
 *
 * A diferencia de `/2fa/disable` (que borra el secreto TOTP), desvincular
 * Google NO revoca sesiones activas ni exige ningún otro efecto colateral
 * -- la cuenta sigue siendo exactamente la misma, solo pierde una vía de
 * inicio de sesión.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ConflictError, NotFoundError } from '../../../lib/errors.js';
import { recordAuthAudit } from '../../../lib/audit.js';
import { assertStepUpOrgId, requireStepUp } from '../../../lib/step-up.js';
import { auditContext } from '../routes.js';
import { unlinkGoogleResponseSchema } from './schemas.js';

export async function googleUnlinkRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const authTier = app.rateLimitSettings.auth;

  server.post(
    '/unlink',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: authTier.max, timeWindow: authTier.timeWindow } },
      schema: { response: { 200: unlinkGoogleResponseSchema } },
    },
    async (request) => {
      const userId = request.userId!;
      const orgId = assertStepUpOrgId(request.headers['x-org-id']);

      const result = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

        await requireStepUp(tx, { userId, stepUpHeader: request.headers['x-step-up'], orgId, purpose: 'auth.google_unlink' });

        const identityRow = await tx.query<{ id: string }>(
          "select id from user_identities where user_id = $1 and provider = 'google'",
          [userId]
        );
        if (identityRow.rows.length === 0) {
          return { kind: 'no_identity' as const };
        }

        const userRow = await tx.query<{ password_hash: string | null }>('select password_hash from users where id = $1', [userId]);
        const hasPassword = (userRow.rows[0]?.password_hash ?? null) !== null;
        if (!hasPassword) {
          return { kind: 'no_other_access_method' as const };
        }

        // `user_identities` (0071) tenía RLS con políticas de SELECT/INSERT
        // únicamente -- 0093 agregó la de DELETE (mismo patrón que
        // `user_totp_secrets`/`user_backup_codes`, 0057). Se comprueba
        // `rowCount` explícitamente: sin una política de DELETE que
        // aplique, Postgres no lanza ningún error, simplemente no borra
        // ninguna fila -- este chequeo convierte ese silencio en un 500
        // real (nunca un `unlinked: true` mentiroso) si alguna migración
        // futura llegara a quitar esa política sin querer.
        const deleted = await tx.query("delete from user_identities where user_id = $1 and provider = 'google'", [userId]);
        if (deleted.rowCount === 0) {
          throw new Error('google_unlink_delete_affected_zero_rows');
        }

        await recordAuthAudit(tx, {
          actorId: userId,
          action: 'auth.google_unlinked',
          after: auditContext(request),
          requestId: request.id,
        });

        return { kind: 'ok' as const };
      });

      if (result.kind === 'no_identity') {
        throw new NotFoundError('Esta cuenta no tiene una identidad de Google vinculada.');
      }
      if (result.kind === 'no_other_access_method') {
        throw new ConflictError(
          'No se puede desvincular Google: esta cuenta no tiene contraseña propia y quedaría sin ningún método de acceso. Configure una contraseña primero (restablecerla vía "olvidé mi contraseña" también sirve para ponerla por primera vez).'
        );
      }
      return { unlinked: true as const };
    }
  );
}
