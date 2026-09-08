import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { verifyRefreshToken } from '../../lib/jwt.js';
import { NotFoundError, UnauthorizedError } from '../../lib/errors.js';
import { recordAuthAudit } from '../../lib/audit.js';
import { auditContext } from './routes.js';
import {
  sessionsListSchema,
  sessionIdParamsSchema,
  revokeSessionResponseSchema,
  revokeOtherSessionsBodySchema,
  revokeOtherSessionsResponseSchema,
} from './schemas.js';

/**
 * `refresh_tokens.token_hash` NUNCA es sha256 del JWT completo -- es
 * sha256 del `jti` (id de un solo uso) que va DENTRO del JWT (ver
 * `issueTokenPair`/`POST /auth/refresh`/`POST /auth/logout` en
 * `modules/auth/routes.ts`, todos hashean `payload.jti`, nunca el token
 * crudo). Aquí se hace exactamente lo mismo: primero se verifica la firma
 * del JWT (rechaza cualquier token inventado/expirado/de otro secreto con
 * un 401 explícito, nunca deja que `jwt.verify` lance sin capturar) y
 * SOLO ENTONCES se hashea el `jti` ya extraído -- hashear el token crudo
 * jamás coincidiría con ninguna fila real de `refresh_tokens`.
 */
async function hashRefreshTokenForLookup(jwtSecret: string, refreshToken: string): Promise<string> {
  let jti: string;
  try {
    const payload = await verifyRefreshToken(jwtSecret, refreshToken);
    jti = payload.jti;
  } catch {
    throw new UnauthorizedError('El refreshToken enviado no es válido.');
  }
  return createHash('sha256').update(jti).digest('hex');
}

export async function sessionsRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/sessions',
    { preHandler: [app.authenticate], schema: { response: { 200: sessionsListSchema } } },
    async (request) => {
      const userId = request.userId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        return tx.query<{ id: string; created_at: string; expires_at: string; ip_address: string | null; user_agent: string | null }>(
          'select * from app.list_active_refresh_tokens()'
        );
      });
      return {
        sessions: rows.map((row) => ({
          id: row.id,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          ipAddress: row.ip_address,
          userAgent: row.user_agent,
        })),
      };
    }
  );

  server.delete(
    '/sessions/:id',
    { preHandler: [app.authenticate], schema: { params: sessionIdParamsSchema, response: { 200: revokeSessionResponseSchema } } },
    async (request) => {
      const userId = request.userId!;
      const { id } = request.params;

      const revoked = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        const { rows } = await tx.query<{ out_id: string }>('select * from app.revoke_refresh_token_by_id($1)', [id]);
        if (rows.length === 0) return false;

        // API-13: cerrar una sesión concreta queda en audit_log (mismo
        // patrón que `auth.logout`) -- `entityId` de la sesión cerrada, no
        // del actor (que ya va en `actor_id`), para poder distinguir en
        // retrospectiva CUÁL de las sesiones del usuario se cerró.
        await recordAuthAudit(tx, {
          actorId: userId,
          action: 'auth.session_revoked',
          after: { sessionId: id, ...auditContext(request) },
          requestId: request.id,
          correlationId: request.correlationId,
        });
        return true;
      });

      // 0 filas: id inexistente, ya revocado/expirado, o de OTRO usuario --
      // un solo mensaje para las tres, sin distinguir (mismo criterio que el
      // resto de `apps/api` con recursos ajenos: nunca confirmar que un id
      // pertenece a otra cuenta).
      if (!revoked) {
        throw new NotFoundError('Sesión no encontrada, ya cerrada, o no pertenece a este usuario.');
      }
      return { revoked: true as const };
    }
  );

  server.post(
    '/sessions/revoke-others',
    {
      preHandler: [app.authenticate],
      schema: { body: revokeOtherSessionsBodySchema, response: { 200: revokeOtherSessionsResponseSchema } },
    },
    async (request) => {
      const userId = request.userId!;
      const keepHash = await hashRefreshTokenForLookup(app.config.jwtSecret, request.body.refreshToken);

      let revokedCount: number;
      try {
        revokedCount = await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
          const { rows } = await tx.query<{ revoke_other_refresh_tokens: number }>('select app.revoke_other_refresh_tokens($1)', [keepHash]);
          const count = rows[0]?.revoke_other_refresh_tokens ?? 0;

          await recordAuthAudit(tx, {
            actorId: userId,
            action: 'auth.sessions_revoked_others',
            after: { revokedCount: count, ...auditContext(request) },
            requestId: request.id,
            correlationId: request.correlationId,
          });
          return count;
        });
      } catch (err) {
        // `app.revoke_other_refresh_tokens` lanza (mensaje
        // `revoke_other_refresh_tokens_current_session_not_found`) si
        // `refreshToken` no corresponde a una sesión VIGENTE de este
        // usuario -- nunca se deja que eso revoque "todo por si acaso" (ver
        // docstring de la función en la migración 0092). Se distingue por
        // mensaje (mismo patrón que `organizations/routes.ts` con
        // `invitation_not_found` et al.) para no convertir un fallo de
        // infraestructura real en un 401 engañoso.
        const pgErr = err as { message?: string };
        if (pgErr.message?.includes('revoke_other_refresh_tokens_current_session_not_found')) {
          throw new UnauthorizedError(
            'El refreshToken enviado no corresponde a una sesión activa de este usuario -- no se cerró ninguna otra sesión.'
          );
        }
        throw err;
      }

      return { revokedCount };
    }
  );
}
